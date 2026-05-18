import AppKit
import Foundation
import GozdProto

// gozd-rpc:// URLSchemeHandler から呼ばれる RPC dispatcher。
//
// 設計判断:
//
// 1. **actor**。PTYRegistry / AppStateStore など共有状態を内包し、
//    複数の URL リクエストが並行してくる WebKit 側からの呼び出しを serial に処理する。
//
// 2. **path 階層**: `/echo` / `/git/status` / `/fs/readFile` / `/pty/spawn` 等。
//    URL でグルーピングが視認しやすい。
//
// 3. **PTY イベントの WebPage push は dispatcher の責務外**。onPtyData / onPtyExit を
//    init で受け取り、PTYRegistry にそのまま渡す。WebPage への callJavaScript wire-up は
//    Phase 3（URLSchemeHandler 統合段階）で URLSchemeHandler 側が実装する。
//
// 4. **戻り値は proto JSON Data**。失敗は throw。URLSchemeHandler 側が HTTP 200 / 4xx / 5xx と
//    `Access-Control-Allow-Origin: *` ヘッダを付ける。
public actor RpcDispatcher {
  public typealias HookHandler = @Sendable (Gozd_V1_HookMessage) -> Void
  public typealias OpenHandler = @Sendable (String) -> Void
  /// (type, source, message, detail, dir) を renderer に push する通知 callback。
  /// type は "error" / "info"、dir は失敗の発生源 worktree path / project anchor dir
  /// (renderer 側が `findRepoOwning(dir)` で repo を特定する手がかり)。
  /// 特定不能 / 経路に紐付かない通知では空文字を渡す。
  /// GozdApp 側の sendNotify と同じシグネチャ。
  public typealias NotifyHandler = @Sendable (String, String, String, String, String) -> Void

  private let pty: PTYRegistry
  private let fsWatch: FSWatchRegistry
  private let appState: AppStateStore
  private let appConfig: AppConfigStore
  private let projectConfig: ProjectConfigStore
  private let tasks: TaskStore
  private let claudeSessions: ClaudeSessionStore
  private let onHook: HookHandler
  private let onOpen: OpenHandler
  private let onNotify: NotifyHandler

  public init(
    configDir: String,
    onPtyText: @escaping @Sendable (UInt32, String) -> Void,
    onPtyExit: @escaping @Sendable (UInt32, PTYExitReason) -> Void,
    onHook: @escaping HookHandler = { _ in },
    onOpen: @escaping OpenHandler = { _ in },
    onFsChange: @escaping FSWatchRegistry.FsChangeHandler = { _, _ in },
    onGitStatusChange: @escaping FSWatchRegistry.GitStatusChangeHandler = { _, _ in },
    onBranchChange: @escaping FSWatchRegistry.BranchChangeHandler = { _ in },
    onRemoteRefsChange: @escaping FSWatchRegistry.RemoteRefsChangeHandler = { _ in },
    onWorktreeChange: @escaping FSWatchRegistry.WorktreeChangeHandler = { _ in },
    onNotify: @escaping NotifyHandler = { _, _, _, _, _ in },
    envOverlay: GozdEnvOverlay? = nil,
    pidTracker: PidTracker? = nil
  ) {
    self.pty = PTYRegistry(
      onText: onPtyText, onExit: onPtyExit, envOverlay: envOverlay, pidTracker: pidTracker)
    self.fsWatch = FSWatchRegistry(
      onFsChange: onFsChange,
      onGitStatusChange: onGitStatusChange,
      onBranchChange: onBranchChange,
      onRemoteRefsChange: onRemoteRefsChange,
      onWorktreeChange: onWorktreeChange
    )
    self.appState = AppStateStore(configDir: configDir)
    self.appConfig = AppConfigStore(configDir: configDir)
    self.projectConfig = ProjectConfigStore(configDir: configDir)
    self.tasks = TaskStore(configDir: configDir)
    self.claudeSessions = ClaudeSessionStore(configDir: configDir)
    self.onHook = onHook
    self.onOpen = onOpen
    self.onNotify = onNotify
  }

  // MARK: - Inbound (SocketServer NDJSON line)

  /// SocketServer から渡された NDJSON 1 行を ClientMessage としてデコードして適切な
  /// callback に振り分ける。decode 失敗時は SocketDecodeError を throw する。
  ///
  /// 設計判断: gozd-rpc:// 経由の RPC（dispatch）と違いリプライがない fire-and-forget
  /// なので、戻り値も Data ではなく Void。失敗は呼び出し側でログするだけで握りつぶさない。
  public func handleSocketMessage(_ data: Data) async throws {
    let msg = try Gozd_V1_ClientMessage(jsonUTF8Data: data)
    guard let body = msg.body else {
      throw SocketDecodeError.emptyOneof
    }
    switch body {
    case .hook(let hook):
      // Claude セッション永続化は dispatcher の責務として内部処理する。
      // 永続化は同 actor 内で直接 await して逐次化する：Task に逃がすと、
      // 同 ptyId に対する session-start / session-end / 次の session-start の
      // 実行順序が submit 順と一致しなくなり、PTYRegistry の sessionIdById マッピング
      // との整合が崩れる。session 系 hook は頻度が低いので onHook の push を待たせる
      // 影響は小さい。
      if hook.event == "session-start" || hook.event == "session-end" {
        let worktreePath = await pty.worktreePath(for: hook.ptyID) ?? ""
        await applyClaudeSessionHook(hook, worktreePath: worktreePath)
      }
      onHook(hook)
    case .open(let open):
      onOpen(open.targetPath)
    }
  }

  private func applyClaudeSessionHook(
    _ hook: Gozd_V1_HookMessage, worktreePath: String
  ) async {
    guard !hook.sessionID.isEmpty else { return }
    if worktreePath.isEmpty {
      // worktreePath 空には 2 つの異なる経路がある。観察ログで区別する:
      // (a) 削除 RPC で clearAssociations 済み → 「Claude 起動直後の closePane」で
      //     生じる late hook を構造的に弾いた正常パス。skip と明記する。
      // (b) そもそも未登録 ptyId → spawn 経路の不整合、調査対象。error と明記する。
      if await pty.wasExplicitlyRemoved(hook.ptyID) {
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] late \(hook.event) for pty=\(hook.ptyID) session=\(hook.sessionID) after removeByPty; skipping\n"
              .utf8))
      } else {
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] \(hook.event) for unknown pty=\(hook.ptyID); skipping\n"
              .utf8))
      }
      return
    }
    do {
      switch hook.event {
      case "session-start":
        // 同 ptyId で前回観測した sessionId と異なるなら、PTY 内で `/clear` や
        // `--resume` でセッションが切り替わったケース。Claude は旧セッションの
        // session-end を発火しないため、ここで明示的に掃除する。worktree 全削除
        // ではなく ptyId スコープに限るので、別 PTY（別 leaf）の生きたセッションは
        // 触らない。複数 leaf で並列に Claude を走らせるユースケースを壊さない。
        // 直近 sessionId は PTYRegistry に保持し、unregisterPane 経由の削除 RPC
        // （/claudeSession/removeByPty）からも同じマッピングを参照する。
        if let previous = await pty.sessionId(for: hook.ptyID),
          previous != hook.sessionID
        {
          try await claudeSessions.removeBySessionId(
            worktreePath: worktreePath, sessionId: previous)
          // 旧 session を持っていた Task から sessionID を切り離す。task 本体は
          // 残し (gh_ref があれば永続)、新 session 開始経路 (attachSession)
          // と矛盾しないよう「sessionID 空 + 同 worktree」候補を増やす。
          do {
            try await tasks.detachSession(dir: worktreePath, sessionId: previous)
          } catch {
            FileHandle.standardError.write(
              Data("[TaskStore] detachSession (previous) failed: \(error)\n".utf8))
            onNotify(
              "error", "task-store", "Failed to detach previous session from task",
              String(describing: error), worktreePath)
          }
        }
        // expected resume sid を必ず消費する。これで removeByPty 経路の
        // 「expected 残存 = SessionStart 不達 = resume 失敗」判定が意味的に閉じる。
        // 返り値が hook.sessionID と一致 → resume 成功 (no-op、attachSession が冪等処理)。
        // 不一致かつ非空 → `claude --resume X` が失敗して zsh が素の `claude` に
        // fallback したケース。dead expected を claudeSessions と tasks から掃除して、
        // 後段 attachSession(Y) が「sessionID 空の最新 task」を再 attach できる候補に
        // するため道を空ける (clearDeadSession で X 持ち task の sessionID が空に
        // 書き戻されることで attachSession の候補ピックアップに乗る。元 task の id に
        // 固定指定しているわけではないので、同 worktree に他 sessionID 空 task があれば
        // createdAt 最新の方が拾われる)。pane close を待たずに新 sid で復活させるため、
        // upsert(Y) / attachSession(Y) の前段で必ず実行する。
        let expectedSid = (await pty.consumeExpectedResumeSid(for: hook.ptyID)) ?? ""
        if !expectedSid.isEmpty && expectedSid != hook.sessionID {
          do {
            try await claudeSessions.removeBySessionId(
              worktreePath: worktreePath, sessionId: expectedSid)
          } catch {
            FileHandle.standardError.write(
              Data(
                "[ClaudeSessionStore] resume-failure cleanup (session-start fallback) failed: \(error)\n"
                  .utf8))
            onNotify(
              "error", "claude-sessions",
              "Failed to clean up after resume failure (fallback)",
              String(describing: error), worktreePath)
          }
          do {
            // session-start fallback 経路: hidden は据え置き (markHiddenIfGhRef=false)。
            // 直後の `attachSession(hook.sessionID)` が hidden=false な ghRef task を
            // 拾って自動転移する設計のため、ここで hidden=true を立てるとピック対象から
            // 外れて転移が壊れる。
            try await tasks.clearDeadSession(
              dir: worktreePath, sessionId: expectedSid, markHiddenIfGhRef: false)
          } catch {
            FileHandle.standardError.write(
              Data(
                "[TaskStore] clearDeadSession (session-start fallback) failed: \(error)\n"
                  .utf8))
            onNotify(
              "error", "task-store",
              "Failed to clear dead session from task after resume failure (fallback)",
              String(describing: error), worktreePath)
          }
        }
        // 永続化を先に成功させてから PTYRegistry のマッピングを更新する。
        // 逆順だと upsert が throw した場合 PTYRegistry だけ新 sessionId に進み、
        // 次回 cleanup の根拠（永続化と同期した sessionId）を失う。
        try await claudeSessions.upsert(
          worktreePath: worktreePath,
          sessionId: hook.sessionID
        )
        // SessionStart hook: 該当 worktree で sessionID 空の最新 task に attach。
        // 無ければ新規 task を作る (PR/issue picker を経ない Claude 直接起動経路)。
        // attachSession が throw した場合は直前の upsert(Y) を rollback して中間状態
        // (「claude-sessions に Y は存在 / 対応 task は紐付け無し」の孤児 Y) を残さない。
        // rollback しないと UI 上「task に session が付かないまま claude-sessions だけ
        // 増えていく」観察不能な leak を生む。pty.setSessionId も skip して PTYRegistry
        // と永続化の sid を取り違えないようにする。
        do {
          try await tasks.attachSession(
            dir: worktreePath,
            sessionId: hook.sessionID,
            worktreeDir: worktreePath
          )
          await pty.setSessionId(for: hook.ptyID, sessionId: hook.sessionID)
        } catch {
          FileHandle.standardError.write(
            Data("[TaskStore] attachSession failed: \(error)\n".utf8))
          onNotify(
            "error", "task-store", "Failed to attach session to task",
            String(describing: error), worktreePath)
          do {
            try await claudeSessions.removeBySessionId(
              worktreePath: worktreePath, sessionId: hook.sessionID)
          } catch {
            FileHandle.standardError.write(
              Data(
                "[ClaudeSessionStore] attachSession rollback (upsert revert) failed: \(error)\n"
                  .utf8))
            onNotify(
              "error", "claude-sessions",
              "Failed to rollback claude-sessions after attachSession failure",
              String(describing: error), worktreePath)
          }
        }
      case "session-end":
        // 永続化削除を先に成功させてから PTYRegistry のマッピングを消す。
        // 逆順だと removeBySessionId が throw した場合 PTYRegistry からは消えるが
        // 永続化には残り続け、次回 cleanup（removeByPty）で sessionId 解決ができない。
        try await claudeSessions.removeBySessionId(
          worktreePath: worktreePath, sessionId: hook.sessionID)
        // SessionEnd: task.sessionID は保持して `claude --resume` の起点に使う。
        // gh_ref が空の task のみ削除する (Claude 直接起動 + 即終了の残骸)。
        do {
          try await tasks.detachSession(dir: worktreePath, sessionId: hook.sessionID)
        } catch {
          FileHandle.standardError.write(
            Data("[TaskStore] detachSession failed: \(error)\n".utf8))
          onNotify(
            "error", "task-store", "Failed to detach session from task",
            String(describing: error), worktreePath)
        }
        await pty.clearSessionId(for: hook.ptyID)
      default:
        // 呼び出し元 handleSocketMessage が hook.event を session-start /
        // session-end に絞り込んでから呼ぶため到達しない。外側 catch の switch と
        // 対称に観察可能化する (silent break で将来フィルタが緩んだとき no-op に
        // ならないように)。
        preconditionFailure(
          "applyClaudeSessionHook reached with unexpected event: \(hook.event)")
      }
    } catch {
      // claudeSessions.upsert / removeBySessionId / pty.setSessionId / pty.sessionId
      // などの外側 throw を拾う catch。session-start / session-end の永続化失敗は
      // 後段 fetch でも復旧経路が無いため、TaskStore 失敗と対称に renderer へ
      // notify する。dir は worktreePath が解決済みなのでそのまま渡す。
      // message は TaskStore 側と同じく経路ごとに静的列挙して、トースト UI で
      // 運用者が経路を識別できるようにする。
      FileHandle.standardError.write(
        Data("[ClaudeSessionStore] \(hook.event) failed: \(error)\n".utf8))
      let message: String
      switch hook.event {
      case "session-start":
        message = "Failed to persist new Claude session"
      case "session-end":
        message = "Failed to remove ended Claude session"
      default:
        // applyClaudeSessionHook は呼び出し元 (handleSocketMessage) で hook.event を
        // session-start / session-end に絞り込んでから呼ばれるため、ここには到達しない。
        // Swift の String switch は default が必須なので明示的に観察可能化する。
        preconditionFailure(
          "applyClaudeSessionHook reached with unexpected event: \(hook.event)")
      }
      onNotify(
        "error", "claude-sessions", message, String(describing: error), worktreePath)
    }
  }

  public func dispatch(path: String, body: Data) async throws -> Data {
    switch path {
    case "/echo":
      return try await handleEcho(body)
    case "/git/status":
      return try await handleGitStatus(body)
    case "/fs/readFile":
      return try handleFsReadFile(body)
    case "/fs/readDir":
      return try await handleFsReadDir(body)
    case "/fs/watch":
      return try await handleFsWatch(body)
    case "/fs/unwatch":
      return try await handleFsUnwatch(body)
    case "/fs/unwatchAll":
      return try await handleFsUnwatchAll(body)
    case "/pty/spawn":
      return try await handlePtySpawn(body)
    case "/pty/write":
      return try await handlePtyWrite(body)
    case "/pty/resize":
      return try await handlePtyResize(body)
    case "/pty/kill":
      return try await handlePtyKill(body)
    case "/appState/load":
      return try handleLoadAppState(body)
    case "/appState/save":
      return try handleSaveAppState(body)
    case "/appConfig/load":
      return try handleLoadAppConfig(body)
    case "/appConfig/save":
      return try handleSaveAppConfig(body)
    case "/open/external":
      return try handleOpenExternal(body)
    case "/open/pickAndOpen":
      return try await handlePickAndOpen(body)
    case "/git/worktreeList":
      return try await handleGitWorktreeList(body)
    case "/git/log":
      return try await handleGitLog(body)
    case "/git/diffHunks":
      return try await handleGitDiffHunks(body)
    case "/git/diffExpandLines":
      return try handleGitDiffExpandLines(body)
    case "/git/showFile":
      return try await handleGitShowFile(body)
    case "/git/showCommitFile":
      return try await handleGitShowCommitFile(body)
    case "/git/commitFiles":
      return try await handleGitCommitFiles(body)
    case "/git/prList":
      return try await handleGitPrList(body)
    case "/git/issueList":
      return try await handleGitIssueList(body)
    case "/git/viewer":
      return try await handleGitViewer(body)
    case "/git/fetchRemotes":
      return try await handleGitFetchRemotes(body)
    case "/git/defaultBranch":
      return try await handleGitDefaultBranch(body)
    case "/git/githubIdentity":
      return try await handleGitGithubIdentity(body)
    case "/git/createWorktree":
      return try await handleCreateWorktree(body)
    case "/git/worktreeRemove":
      return try await handleWorktreeRemove(body)
    case "/task/add":
      return try await handleTaskAdd(body)
    case "/task/update":
      return try await handleTaskUpdate(body)
    case "/fs/readFileAbsolute":
      return try handleFsReadFileAbsolute(body)
    case "/fs/writeFile":
      return try handleFsWriteFile(body)
    case "/fs/stat":
      return try handleFsStat(body)
    case "/projectConfig/load":
      return try handleProjectConfigLoad(body)
    case "/projectConfig/save":
      return try handleProjectConfigSave(body)
    case "/shellCommand/install":
      return try handleShellCommandInstall(body)
    case "/shellCommand/uninstall":
      return try handleShellCommandUninstall(body)
    case "/voicevox/launch":
      return try await handleVoicevoxLaunch(body)
    case "/voicevox/checkEngine":
      return try await handleVoicevoxCheckEngine(body)
    case "/voicevox/speak":
      return try await handleVoicevoxSpeak(body)
    case "/window/close":
      return try handleWindowClose(body)
    case "/window/setTitleContext":
      return try await handleWindowSetTitleContext(body)
    case "/claudeSession/listByDir":
      return try await handleClaudeSessionListByDir(body)
    case "/claudeSession/removeByPty":
      return try await handleClaudeSessionRemoveByPty(body)
    default:
      throw RpcError.unknownPath(path)
    }
  }

  // MARK: - handlers

  private func handleEcho(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_EchoRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_EchoResponse()
    resp.text = "echo: \(req.text)"
    return try resp.jsonUTF8Data()
  }

  private func handleGitStatus(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitStatusRequest(jsonUTF8Data: body)
    let status = try await GitOps.gitStatusFull(dir: req.dir)
    var resp = Gozd_V1_GitStatusResponse()
    resp.entries = status.statuses
    if status.hasUpstream {
      var upstream = Gozd_V1_UpstreamStatus()
      upstream.ahead = status.ahead
      upstream.behind = status.behind
      resp.upstream = upstream
    }
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileRequest(jsonUTF8Data: body)
    let info = try FSOps.readFile(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadFileResponse()
    resp.content = info.content
    resp.isBinary = info.isBinary
    resp.isDirectory = info.isDirectory
    resp.notFound = info.notFound
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadDir(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsReadDirRequest(jsonUTF8Data: body)
    let entries = try await FSOps.readDir(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadDirResponse()
    resp.entries = entries.map { entry in
      var e = Gozd_V1_FsReadDirEntry()
      e.name = entry.name
      e.type = entry.type
      e.isIgnored = entry.isIgnored
      return e
    }
    return try resp.jsonUTF8Data()
  }

  private func handleFsWatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsWatchRequest(jsonUTF8Data: body)
    try await fsWatch.watch(dir: req.dir)
    return try Gozd_V1_FsWatchResponse().jsonUTF8Data()
  }

  private func handleFsUnwatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsUnwatchRequest(jsonUTF8Data: body)
    await fsWatch.unwatch(dir: req.dir)
    return try Gozd_V1_FsUnwatchResponse().jsonUTF8Data()
  }

  private func handleFsUnwatchAll(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_FsUnwatchAllRequest(jsonUTF8Data: body)
    let count = await fsWatch.unwatchAll()
    var resp = Gozd_V1_FsUnwatchAllResponse()
    resp.unwatchedCount = UInt32(count)
    return try resp.jsonUTF8Data()
  }

  private func handlePtySpawn(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtySpawnRequest(jsonUTF8Data: body)
    let id = try await pty.spawn(
      executable: req.executable,
      args: req.args,
      env: req.env,
      cwd: req.dir,
      rows: UInt16(req.rows),
      cols: UInt16(req.cols),
      worktreePath: req.worktreePath
    )
    var resp = Gozd_V1_PtySpawnResponse()
    resp.ptyID = id
    return try resp.jsonUTF8Data()
  }

  private func handlePtyWrite(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyWriteRequest(jsonUTF8Data: body)
    await pty.write(id: req.ptyID, data: req.data)
    return try Gozd_V1_PtyWriteResponse().jsonUTF8Data()
  }

  private func handlePtyResize(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyResizeRequest(jsonUTF8Data: body)
    await pty.resize(id: req.ptyID, rows: UInt16(req.rows), cols: UInt16(req.cols))
    return try Gozd_V1_PtyResizeResponse().jsonUTF8Data()
  }

  private func handlePtyKill(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyKillRequest(jsonUTF8Data: body)
    await pty.kill(id: req.ptyID)
    return try Gozd_V1_PtyKillResponse().jsonUTF8Data()
  }

  private func handleLoadAppState(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppStateRequest(jsonUTF8Data: body)
    let state = try appState.load()
    var resp = Gozd_V1_LoadAppStateResponse()
    resp.state = state
    return try resp.jsonUTF8Data()
  }

  private func handleSaveAppState(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppStateRequest(jsonUTF8Data: body)
    try appState.save(req.state)
    return try Gozd_V1_SaveAppStateResponse().jsonUTF8Data()
  }

  private func handleLoadAppConfig(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppConfigRequest(jsonUTF8Data: body)
    let config = try appConfig.load()
    var resp = Gozd_V1_LoadAppConfigResponse()
    resp.config = config
    return try resp.jsonUTF8Data()
  }

  private func handleSaveAppConfig(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppConfigRequest(jsonUTF8Data: body)
    try appConfig.save(req.config)
    return try Gozd_V1_SaveAppConfigResponse().jsonUTF8Data()
  }

  private func handlePickAndOpen(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_PickAndOpenRequest(jsonUTF8Data: body)
    // NSOpenPanel は @MainActor。actor 内から MainActor.run でホップしてユーザー選択を待つ
    let pickedPath = await MainActor.run {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.prompt = "Open"
      panel.message = "Select a directory to open"
      let response = panel.runModal()
      if response == .OK, let url = panel.url {
        return url.path
      }
      return ""
    }
    if !pickedPath.isEmpty {
      onOpen(pickedPath)
    }
    return try Gozd_V1_PickAndOpenResponse().jsonUTF8Data()
  }

  /// `openExternal` で許可する URL scheme の allowlist。
  /// OSC 8 リンクや WebLinksAddon 経由で任意 scheme が流れ込み得るので、
  /// ブラウザで開く想定の scheme のみを許可する。テスト容易性のため純粋関数。
  static let openExternalAllowedSchemes: Set<String> = ["http", "https", "mailto"]

  static func isOpenExternalSchemeAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return openExternalAllowedSchemes.contains(scheme)
  }

  private func handleOpenExternal(_ body: Data) throws -> Data {
    let req = try Gozd_V1_OpenExternalRequest(jsonUTF8Data: body)
    guard let url = URL(string: req.url) else {
      throw RpcError.invalidArgument("invalid url: \(req.url)")
    }
    guard Self.isOpenExternalSchemeAllowed(url) else {
      throw RpcError.invalidArgument("scheme not allowed: \(url.scheme ?? "")")
    }
    // NSWorkspace.open は @MainActor。actor 内から MainActor.run でホップする。
    Task { @MainActor in
      NSWorkspace.shared.open(url)
    }
    return try Gozd_V1_OpenExternalResponse().jsonUTF8Data()
  }

  // MARK: - git ops

  private func handleGitWorktreeList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeListRequest(jsonUTF8Data: body)
    let worktrees = try await GitOps.worktreeList(dir: req.dir)
    let registered = try await claudeSessions.allSavedSessions(forProject: req.dir)
    let registeredSessionIds = Set(registered.map { $0.sessionID })
    let listedTasks = try await tasks.list(dir: req.dir)
    // task ≠ session 設計: 身元 (gh_ref) があれば session が dead でも task 自体は
    // 残るが、サイドバー表示は terminal close で hidden=true に倒されるため除外する。
    // session 単独で生きていた task (root wt 上で直接 claude を起動したケース等) は
    // session が live な間だけ表示し、PTY が消えれば自動で消える。
    // hidden を入り口で弾くことで gh 系 / 直接起動系の挙動を揃える (terminal close で
    // どちらもサイドバーから消える)。gh 系の永続情報は task 本体に残り、PR/issue picker
    // で同じ識別子を再選択すると `TaskStore.add` の upsert で再表示される。
    let allTasks = listedTasks.filter { task in
      if task.hidden { return false }
      if task.hasNonSessionIdentity { return true }
      return !task.sessionID.isEmpty && registeredSessionIds.contains(task.sessionID)
    }
    // 各 wt の git status は補助データ。1 wt の失敗で worktree list 全体を捨てない
    // ため、per-wt で握って空 statuses で続行する。prunable wt は listing から除外
    // 済みなので、ここで失敗するのは worktree 実 path 不整合などの稀ケース。失敗は
    // stderr に残して silent 握り潰しを避ける (主経路に throw は伝播させない)。
    let fullByPath: [String: GitOps.StatusFull] = await withTaskGroup(
      of: (String, GitOps.StatusFull?).self
    ) { group in
      for wt in worktrees {
        let path = wt.path
        group.addTask {
          do {
            let full = try await GitOps.gitStatusFull(dir: path)
            return (path, full)
          } catch {
            FileHandle.standardError.write(
              Data(
                "[handleGitWorktreeList] gitStatusFull failed for \(path): \(error)\n"
                  .utf8))
            return (path, nil)
          }
        }
      }
      var result: [String: GitOps.StatusFull] = [:]
      for await (path, full) in group {
        if let full { result[path] = full }
      }
      return result
    }
    var resp = Gozd_V1_GitWorktreeListResponse()
    resp.worktrees = worktrees.map { wt in
      var entry = Gozd_V1_WorktreeEntry()
      entry.path = wt.path
      entry.head = wt.head
      entry.branch = wt.branch ?? ""
      entry.isMain = wt.isMain
      let full = fullByPath[wt.path]
      entry.gitStatuses = full?.statuses ?? [:]
      if let full, full.hasUpstream {
        var upstream = Gozd_V1_UpstreamStatus()
        upstream.ahead = full.ahead
        upstream.behind = full.behind
        entry.upstream = upstream
      }
      // この worktree に紐づく全 Task を埋める。1 wt = 複数 Claude session の前提で
      // session 単位の Task が複数並ぶ。
      entry.tasks = allTasks.filter { $0.worktreeDir == wt.path }
      return entry
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitLog(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitLogRequest(jsonUTF8Data: body)
    let result = try await GitOps.logBoth(
      dir: req.dir, maxCount: req.maxCount, firstParentOnly: req.firstParentOnly)
    func toProto(_ c: CommitInfo) -> Gozd_V1_GitCommit {
      var pb = Gozd_V1_GitCommit()
      pb.hash = c.hash
      pb.shortHash = c.shortHash
      pb.parents = c.parents
      pb.author = c.author
      pb.date = c.date
      pb.message = c.message
      pb.body = c.body
      pb.refs = c.refs
      return pb
    }
    var resp = Gozd_V1_GitLogResponse()
    resp.headCommits = result.headCommits.map(toProto)
    resp.defaultBranchCommits = result.defaultBranchCommits.map(toProto)
    resp.defaultBranch = result.defaultBranch
    return try resp.jsonUTF8Data()
  }

  private func handleGitDiffHunks(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitDiffHunksRequest(jsonUTF8Data: body)
    let result = try await GitOps.diffHunks(original: req.original, current: req.current)
    var resp = Gozd_V1_GitDiffHunksResponse()
    resp.oldTotalLines = result.oldTotalLines
    resp.newTotalLines = result.newTotalLines
    resp.hunks = result.hunks.map { h in
      var pb = Gozd_V1_DiffHunk()
      pb.oldStart = h.oldStart
      pb.oldLines = h.oldLines
      pb.newStart = h.newStart
      pb.newLines = h.newLines
      pb.lines = h.lines.map { l in
        var pbLine = Gozd_V1_DiffHunkLine()
        pbLine.kind =
          switch l.kind {
          case .context: .context
          case .added: .added
          case .removed: .removed
          }
        pbLine.text = l.text
        return pbLine
      }
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitDiffExpandLines(_ body: Data) throws -> Data {
    let req = try Gozd_V1_GitDiffExpandLinesRequest(jsonUTF8Data: body)
    let result = try GitOps.expandDiffLines(
      original: req.original,
      current: req.current,
      oldStart: req.oldStart,
      newStart: req.newStart,
      lines: req.lines
    )
    var resp = Gozd_V1_GitDiffExpandLinesResponse()
    resp.lines = result.map { entry in
      var pb = Gozd_V1_DiffExpandedLine()
      pb.oldLineNo = entry.oldLineNo
      pb.newLineNo = entry.newLineNo
      pb.oldText = entry.oldText
      pb.newText = entry.newText
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitShowFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowFileResponse()
    resp.result = await fileReadResultFromGit(dir: req.dir, hash: "HEAD", relPath: req.relPath)
    return try resp.jsonUTF8Data()
  }

  private func handleGitShowCommitFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowCommitFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowCommitFileResponse()
    // 単一コミット選択 (compareHash 空) では GitHub と同等の <hash>^ vs <hash> 比較に揃える。
    // GitOps.commitFiles のファイル一覧と diff endpoint を一致させるため。
    // root commit は <hash>^ が解決失敗 → notFound=true となり追加扱いに自然解決する。
    // 範囲選択 (compareHash 非空) では GitOps.commitFiles の <older>^ vs <newer> に揃え、
    // older 端自身の変更も diff に含める。root commit は `^` 解決失敗 → notFound に倒れる。
    // Working Tree 端の扱いは renderer 側で分岐し、wire には常に実 git hash のみ流れる契約。
    let olderEnd = req.compareHash.isEmpty ? req.hash : req.compareHash
    let fromHash = "\(olderEnd)^"
    // content と OID を並行取得。両端の blob OID が一致すれば
    // 「コミット範囲で変更なし」として renderer に伝える（Filer 経由の非変更ファイル選択を救済）。
    async let fromContent = fileReadResultFromGit(
      dir: req.dir, hash: fromHash, relPath: req.relPath)
    async let toContent = fileReadResultFromGit(
      dir: req.dir, hash: req.hash, relPath: req.relPath)
    async let fromOID = GitOps.treeFileOID(
      dir: req.dir, hash: fromHash, relPath: req.relPath)
    async let toOID = GitOps.treeFileOID(
      dir: req.dir, hash: req.hash, relPath: req.relPath)
    let (from, to, fOID, tOID) = await (fromContent, toContent, fromOID, toOID)
    resp.from = from
    resp.to = to
    // 両 OID が解決でき、かつ一致した場合のみ true。proto3 default false 依存にせず明示代入。
    resp.unchanged = fOID != nil && tOID != nil && fOID == tOID
    return try resp.jsonUTF8Data()
  }

  /// `git show <hash>:<path>` の結果を FileReadResult shape にまとめる。
  /// 失敗（exit != 0）= ファイル不在として not_found=true を返す。
  /// 想定する失敗: root commit の `^` 解決失敗、未追跡 path、invalid hash。
  /// それ以外（commandFailed の予期しない exit code 等）は silent drop しないよう
  /// stderr にログを残して dev 環境で観察可能にする。
  private func fileReadResultFromGit(dir: String, hash: String, relPath: String) async
    -> Gozd_V1_FileReadResult
  {
    var fr = Gozd_V1_FileReadResult()
    do {
      let data = try await GitOps.showCommitFile(dir: dir, hash: hash, relPath: relPath)
      if data.contains(0x00) {
        fr.isBinary = true
      } else if let text = String(data: data, encoding: .utf8) {
        fr.content = text
      } else {
        fr.isBinary = true
      }
    } catch {
      fr.notFound = true
      FileHandle.standardError.write(
        Data(
          "[RpcDispatcher] git show \(hash):\(relPath) failed in \(dir): \(error)\n".utf8
        )
      )
    }
    return fr
  }

  private func handleGitCommitFiles(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitCommitFilesRequest(jsonUTF8Data: body)
    let compare = req.compareHash.isEmpty ? nil : req.compareHash
    let changes = try await GitOps.commitFiles(
      dir: req.dir, hash: req.hash, compareHash: compare, rangeHashes: req.rangeHashes,
      includeWorkingTree: req.includeWorkingTree)
    var resp = Gozd_V1_GitCommitFilesResponse()
    resp.changes = changes.map { c in
      var pb = Gozd_V1_GitFileChange()
      pb.oldFilePath = c.oldPath
      pb.newFilePath = c.newPath
      pb.type = c.type
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitPrList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitPrListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitPrListResponse()
    switch try await GitHubOps.prList(dir: req.dir) {
    case .success(let prs):
      resp.ok = true
      resp.prs = prs.map { p in
        var pb = Gozd_V1_GitPullRequest()
        pb.number = p.number
        pb.title = p.title
        pb.url = p.url
        pb.state = p.state
        pb.author = p.author
        pb.headRef = p.headRef
        pb.baseRef = p.baseRef
        pb.isDraft = p.isDraft
        pb.assignees = p.assignees
        pb.reviewers = p.reviewers
        pb.updatedAt = p.updatedAt
        pb.authorAvatarURL = p.authorAvatarUrl
        return pb
      }
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitIssueList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitIssueListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitIssueListResponse()
    switch try await GitHubOps.issueList(dir: req.dir) {
    case .success(let issues):
      resp.ok = true
      resp.issues = issues.map { i in
        var pb = Gozd_V1_GitIssue()
        pb.number = i.number
        pb.title = i.title
        pb.url = i.url
        pb.state = i.state
        pb.author = i.author
        pb.labels = i.labels
        pb.assignees = i.assignees
        pb.updatedAt = i.updatedAt
        pb.authorAvatarURL = i.authorAvatarUrl
        return pb
      }
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitViewer(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitViewerRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitViewerResponse()
    switch try await GitHubOps.viewer(dir: req.dir) {
    case .success(let login):
      resp.ok = true
      resp.login = login
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }

  /// `GhError.Kind` を proto enum にマップする。proto 側は 0=OK / 1-5=各種失敗。
  private func mapGhErrorKind(_ kind: GhError.Kind) -> Gozd_V1_GhErrorKind {
    switch kind {
    case .rateLimit: return .rateLimit
    case .unauthenticated: return .unauthenticated
    case .repoNotFound: return .repoNotFound
    case .network: return .network
    case .other: return .other
    }
  }

  private func handleGitFetchRemotes(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitFetchRemotesRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitFetchRemotesResponse()
    do {
      try await GitOps.fetchRemotes(dir: req.dir)
      resp.ok = true
    } catch let GitError.commandFailed(_, stderr) {
      // offline / 認証失敗 / remote 未設定 etc. は呼び出し側で握り潰す。
      // stderr 冒頭のみを debug 用に積む (UI には出さない)。
      resp.ok = false
      resp.errorDetail = String(stderr.prefix(512))
    } catch {
      resp.ok = false
      resp.errorDetail = "\(error)"
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitDefaultBranch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitDefaultBranchRequest(jsonUTF8Data: body)
    // worktree 作成の起点として使う ref を返す。`git worktree add -b <new> <abs> <ref>` の
    // `<ref>` にそのまま渡せる文字列（`origin/main` / `main` 等）が caller の期待値。
    //
    // 1) origin/HEAD 経由で remote default branch を取得（`origin/main` 等を full ref で返す。
    //    既存の `GitOps.defaultBranchName` は git-graph 用途で `origin/` prefix を剥がすため
    //    ここでは流用せず、剥がさない形で扱う）
    // 2) 失敗時は main repo root 自身の current branch に fallback（remote 未設定 / push 前 repo）
    // 3) どちらも引けない（detached HEAD / unborn branch）場合は空文字列を返し、caller が通知 + 中止する
    //
    // `commandFailed`（origin/HEAD 未設定 / detached HEAD 等のドメイン失敗）のみ空文字列に
    // 倒し、`launchFailed`（git CLI 解決失敗）は throw して renderer に通知する。
    let branch: String
    do {
      branch = try await resolveStartPoint(dir: req.dir)
    } catch GitError.commandFailed {
      branch = ""
    }
    var resp = Gozd_V1_GitDefaultBranchResponse()
    resp.branch = branch
    return try resp.jsonUTF8Data()
  }

  private func resolveStartPoint(dir: String) async throws -> String {
    // origin/HEAD 未設定（remote 無し / `git remote set-head` 未実行）は `commandFailed`
    // で来るので、それだけ受け流して current branch にフォールバックする。`launchFailed`
    // は rethrow して呼び出し側に伝える。
    do {
      let stdout = try await runGit(
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: dir)
      let text = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      if !text.isEmpty { return text }
    } catch GitError.commandFailed {
      // 次の HEAD fallback に進む
    }
    let stdout = try await runGit(args: ["symbolic-ref", "--short", "HEAD"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
  }

  private func handleGitGithubIdentity(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitGithubIdentityRequest(jsonUTF8Data: body)
    // `repoOwnerName` 内部の `runGit` が `GitError.launchFailed` (git CLI 解決失敗 / PATH 不在等)
    // を throw した場合は rethrow して renderer に通知する (silent drop 禁止規律と整合)。
    // `commandFailed` (git config が remote.origin 未設定で exit) は `RepoIdentity.unsetRemote`
    // に倒され、ここでは throw されない。
    //
    // `repoOwnerName` は `gh pr list` 経路と共有することで、git CLI への入力 / parser /
    // host policy をすべて 1 箇所に集約する SSOT 設計。これにより `gh pr list` で PR が拾える
    // repo では必ず `#N` リンクの base も導出できる、という整合性が構造的に保証される。
    var resp = Gozd_V1_GitGithubIdentityResponse()
    switch try await GitHubOps.repoOwnerName(dir: req.dir) {
    case .ok(let owner, let repo):
      resp.owner = owner
      resp.repo = repo
    case .unsetRemote:
      // remote 未設定 (新規 repo / fork なし)。UI には出ないが観察可能にする。
      FileHandle.standardError.write(
        Data("[handleGitGithubIdentity] remote.origin not set for dir=\(req.dir)\n".utf8))
    case .parserRejected:
      // 非 github.com host / 想定外 URL 形式。raw URL は credential 漏出防止のため
      // stderr にも載せない (固定文言 + dir のみで切り分け)。
      FileHandle.standardError.write(
        Data("[handleGitGithubIdentity] unsupported remote URL for dir=\(req.dir)\n".utf8))
    }
    return try resp.jsonUTF8Data()
  }

  private func handleCreateWorktree(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_CreateWorktreeRequest(jsonUTF8Data: body)
    let startPoint = req.startPoint.isEmpty ? nil : req.startPoint
    let info = try await WorktreeOps.createWorktree(
      dir: req.dir, worktreeDir: req.worktreeDir, branch: req.branch, startPoint: startPoint)
    var resp = Gozd_V1_CreateWorktreeResponse()
    var entry = Gozd_V1_WorktreeEntry()
    entry.path = info.path
    entry.head = info.head
    entry.branch = info.branch ?? ""
    entry.isMain = info.isMain
    resp.worktree = entry
    resp.dir = info.path
    return try resp.jsonUTF8Data()
  }

  private func handleWorktreeRemove(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeRemoveRequest(jsonUTF8Data: body)
    try await WorktreeOps.removeWorktree(dir: req.dir, path: req.path, force: req.force)
    // worktree が消えたら紐づく Claude セッション残骸も掃除する。
    // projectKey 解決は req.dir（main repo dir、削除されない側）から行う。
    // req.path は物理削除された後なので、これを anchor にすると
    // projectKey が変わって別ファイルを参照してしまう。
    try await claudeSessions.removeByWorktreePath(
      projectAnchorDir: req.dir, worktreePath: req.path
    )
    // worktree 物理削除に Task の片付けも連動させる。task は worktreeDir に紐づく
    // 永続オブジェクトなので、claudeSessions だけ消して tasks を放置すると
    // `tasks.json` に孤児 Task が残り、サイドバーにゾンビ行が出る
    // (handleClaudeSessionRemoveByPty と対称)。失敗は notify でユーザーに伝え、
    // claudeSessions 側の成功を巻き戻さない。
    do {
      try await tasks.removeByWorktree(dir: req.dir, worktreePath: req.path)
    } catch {
      FileHandle.standardError.write(
        Data("[TaskStore] removeByWorktree failed: \(error)\n".utf8))
      onNotify(
        "error", "task-store", "Failed to clean up tasks after worktree removal",
        String(describing: error), req.dir)
    }
    return try Gozd_V1_GitWorktreeRemoveResponse().jsonUTF8Data()
  }

  private func handleClaudeSessionListByDir(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_ClaudeSessionListByDirRequest(jsonUTF8Data: body)
    let sessions = try await claudeSessions.savedSessions(for: req.dir)
    var resp = Gozd_V1_ClaudeSessionListByDirResponse()
    resp.sessions = sessions
    return try resp.jsonUTF8Data()
  }

  private func handleClaudeSessionRemoveByPty(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_ClaudeSessionRemoveByPtyRequest(jsonUTF8Data: body)
    // sessionId / worktreePath 紐付けを **必ず** クリアする。removeBySessionId が
    // throw して早期 return しても late session-start hook を弾く必要があるため、
    // do-catch + 後置クリアで順序を保証する。
    // これにより「Claude 起動直後の closePane」で発生しうる upsert race を構造的に防ぐ。
    var removeError: Error?
    var removedSessionId = ""

    // expected resume sid は SessionStart 経路 (applyClaudeSessionHook) で一度
    // 着弾した時点で必ず consumeExpectedResumeSid されるため、removeByPty 到達時点で
    // 残っているのは「SessionStart hook が一度も着弾していない」ケースに限られる。
    // - 一致 (resume 成功): consume 後の上書きで normal attach
    // - 不一致 (zsh fallback で新 sid 起動): consume + dead expected cleanup を session-start 内で完結
    // - 不達 (zsh fallback も失敗 / ユーザーが素シェルのまま pane 閉鎖): expected 残存
    let liveSid = (await pty.sessionId(for: req.ptyID)) ?? ""
    let expectedSid = (await pty.consumeExpectedResumeSid(for: req.ptyID)) ?? ""

    // SessionStart 着弾時点で expected を必ず消費するので、removeByPty 時点で
    // 「expected と live が同居」は構造的に発生し得ない (SessionStart 着弾 = expected
    // 消費 = removeByPty では nil)。precondition で契約を明示し、到達したら fatal で
    // 気付ける形にする。
    precondition(
      expectedSid.isEmpty || liveSid.isEmpty,
      "expectedSid (\(expectedSid)) and liveSid (\(liveSid)) both non-empty; SessionStart consume invariant broken"
    )

    if !expectedSid.isEmpty {
      // SessionStart hook が一度も着弾しないまま pane が閉じられた。
      // `claude --resume <sid>` が transcript 不在等で error 終了し、zsh fallback の
      // 素 `claude` も SessionStart 不達のまま終わった (起動エラー / ユーザーが即 /exit)
      // 等のケース。stale な sid を片付ける。
      // - claude-sessions.json: 該当 sid のエントリ削除
      // - tasks.json: clearDeadSession で sid を空に書き換え (ghRef ありなら task 残存、
      //   無ければ削除)。次のクリックで `--resume` ではなく素の claude 起動に流す
      do {
        try await claudeSessions.removeBySessionId(
          worktreePath: req.worktreePath, sessionId: expectedSid)
      } catch {
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] resume-failure cleanup failed: \(error)\n".utf8))
        onNotify(
          "error", "claude-sessions",
          "Failed to clean up after resume failure",
          String(describing: error), req.worktreePath)
      }
      do {
        // removeByPty 経路 (terminal close + resume 失敗): サイドバー表示も消す
        // (markHiddenIfGhRef=true)。pane が閉じているので直後の attachSession は
        // 走らない。再表示は picker での再選択 (`add` の upsert) を待つ。
        try await tasks.clearDeadSession(
          dir: req.worktreePath, sessionId: expectedSid, markHiddenIfGhRef: true)
      } catch {
        FileHandle.standardError.write(
          Data("[TaskStore] clearDeadSession failed: \(error)\n".utf8))
        onNotify(
          "error", "task-store",
          "Failed to clear dead session from task after resume failure",
          String(describing: error), req.worktreePath)
      }
    }

    // live session cleanup。ターミナル close は session-end hook を発火させないため、
    // ここで明示的に task.sessionID を切り離す。gh_ref が空なら同時に task も削除される
    // (detachSession 内部で判定)。これにより root wt 上で直接 claude を起動した
    // task (body のみ、ghRef なし) はターミナル close で揮発する。
    if !liveSid.isEmpty {
      removedSessionId = liveSid
      do {
        try await claudeSessions.removeBySessionId(
          worktreePath: req.worktreePath, sessionId: liveSid)
      } catch {
        removeError = error
      }
      // claudeSessions 側のエラーを優先するため tasks 側は throw しないが、失敗を
      // 放置すると stale な sessionID が残るので notify する。
      do {
        try await tasks.detachSession(dir: req.worktreePath, sessionId: liveSid)
      } catch {
        FileHandle.standardError.write(
          Data("[TaskStore] detachSession (removeByPty) failed: \(error)\n".utf8))
        onNotify(
          "error", "task-store", "Failed to detach session on terminal close",
          String(describing: error), req.worktreePath)
      }
    } else if !expectedSid.isEmpty {
      // live なし + expected あり (純粋な resume 失敗)。removedSessionId に expected を
      // 載せて renderer に「何かは消した」と伝える。renderer 側はこの値を見て
      // lastRemovedSessionInfo を更新し、所属 repo を refetch する。
      removedSessionId = expectedSid
    }
    // else: live も expected もない素 PTY pane (claude を一度も起動しなかった) の close。
    // 正常経路でログ価値が薄いため stderr には残さない。removedSessionId は空のままで、
    // renderer 側は sessionId 空をトリガに refetch を skip する契約。

    await pty.clearAssociations(for: req.ptyID)
    if let error = removeError {
      throw error
    }
    var resp = Gozd_V1_ClaudeSessionRemoveByPtyResponse()
    resp.removedSessionID = removedSessionId
    return try resp.jsonUTF8Data()
  }

  // MARK: - tasks

  // task ≠ Claude session。task は PR/issue/手動操作で作られ、Claude session は
  // task に attach する短命属性 (attachSession / detachSession) として扱う。

  private func handleTaskAdd(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskAddRequest(jsonUTF8Data: body)
    let task = try await tasks.add(
      dir: req.dir,
      body: req.body,
      worktreeDir: req.worktreeDir,
      ghRef: req.hasGhRef ? req.ghRef : nil
    )
    var resp = Gozd_V1_TaskAddResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  private func handleTaskUpdate(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskUpdateRequest(jsonUTF8Data: body)
    let task = try await tasks.update(dir: req.dir, id: req.id, body: req.body)
    var resp = Gozd_V1_TaskUpdateResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  // MARK: - fs extra

  private func handleFsReadFileAbsolute(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileAbsoluteRequest(jsonUTF8Data: body)
    let info = FSOps.readFileAbsolute(absolutePath: req.absolutePath)
    var resp = Gozd_V1_FsReadFileAbsoluteResponse()
    var fr = Gozd_V1_FileReadResult()
    fr.content = info.content
    fr.isBinary = info.isBinary
    fr.isDirectory = info.isDirectory
    fr.notFound = info.notFound
    resp.result = fr
    return try resp.jsonUTF8Data()
  }

  private func handleFsWriteFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsWriteFileRequest(jsonUTF8Data: body)
    try FSOps.writeFile(dir: req.dir, path: req.path, data: req.data)
    return try Gozd_V1_FsWriteFileResponse().jsonUTF8Data()
  }

  private func handleFsStat(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsStatRequest(jsonUTF8Data: body)
    let stat = try FSOps.stat(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsStatResponse()
    resp.exists = stat.exists
    resp.type = stat.type
    resp.size = stat.size
    resp.modifiedAt = stat.modifiedAt
    return try resp.jsonUTF8Data()
  }

  // MARK: - project config

  private func handleProjectConfigLoad(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigLoadRequest(jsonUTF8Data: body)
    let cfg = try projectConfig.load(dir: req.dir)
    var resp = Gozd_V1_ProjectConfigLoadResponse()
    resp.config = cfg
    return try resp.jsonUTF8Data()
  }

  private func handleProjectConfigSave(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigSaveRequest(jsonUTF8Data: body)
    try projectConfig.save(dir: req.dir, config: req.config)
    return try Gozd_V1_ProjectConfigSaveResponse().jsonUTF8Data()
  }

  // MARK: - shell command

  private func handleShellCommandInstall(_ body: Data) throws -> Data {
    _ = try Gozd_V1_ShellCommandInstallRequest(jsonUTF8Data: body)
    let result = try ShellCommandOps.install()
    var resp = Gozd_V1_ShellCommandInstallResponse()
    resp.source = result.source
    resp.target = result.target
    resp.alreadyInstalled = result.alreadyInstalled
    resp.replaced = result.replaced
    return try resp.jsonUTF8Data()
  }

  private func handleShellCommandUninstall(_ body: Data) throws -> Data {
    _ = try Gozd_V1_ShellCommandUninstallRequest(jsonUTF8Data: body)
    let result = try ShellCommandOps.uninstall()
    var resp = Gozd_V1_ShellCommandUninstallResponse()
    resp.source = result.source
    resp.removed = result.removed
    resp.notInstalled = result.notInstalled
    return try resp.jsonUTF8Data()
  }

  // MARK: - voicevox

  private func handleVoicevoxLaunch(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxLaunchRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxLaunchResponse()
    resp.ok = await VoicevoxOps.launch()
    return try resp.jsonUTF8Data()
  }

  private func handleVoicevoxCheckEngine(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxCheckEngineRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxCheckEngineResponse()
    resp.ok = await VoicevoxOps.checkEngine()
    return try resp.jsonUTF8Data()
  }

  private func handleWindowClose(_ body: Data) throws -> Data {
    _ = try Gozd_V1_WindowCloseRequest(jsonUTF8Data: body)
    Task { @MainActor in
      NSApplication.shared.terminate(nil)
    }
    return try Gozd_V1_WindowCloseResponse().jsonUTF8Data()
  }

  private func handleWindowSetTitleContext(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_WindowSetTitleContextRequest(jsonUTF8Data: body)
    let repo = req.repoName
    let wt = req.worktreeName
    // "repo · worktree" 形式に整形。worktree 名が空なら repo 名のみ。
    let text: String
    if wt.isEmpty {
      text = repo
    } else if repo.isEmpty {
      text = wt
    } else {
      text = "\(repo) · \(wt)"
    }
    await MainActor.run {
      TitleContext.shared.text = text
    }
    return try Gozd_V1_WindowSetTitleContextResponse().jsonUTF8Data()
  }

  private func handleVoicevoxSpeak(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_VoicevoxSpeakRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxSpeakResponse()
    if let wav = await VoicevoxOps.speak(
      text: req.text, speedScale: req.speedScale, volumeScale: req.volumeScale,
      speakerId: req.speakerID)
    {
      resp.wav = wav
    }
    return try resp.jsonUTF8Data()
  }
}

public enum RpcError: Error, Equatable {
  case unknownPath(String)
  case invalidArgument(String)
}

public enum SocketDecodeError: Error, Equatable {
  case emptyOneof
}
