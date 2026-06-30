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
// 3. **handler 群は責務別 extension で分割** (`RpcDispatcher+<Group>.swift` in `Rpc/`)。
//    Fs / Pty / AppData / Open / Git / GitHub / Worktree / Task / ClaudeSession / Shell /
//    Voicevox。Swift の extension は同型 `private` member を別ファイルから参照できないため、
//    stored properties は `internal` (no modifier) で module 内に開く。encapsulation 境界は
//    GozdCore module 単位。
//
// 4. **PTY イベントの WebPage push は dispatcher の責務外**。onPtyData / onPtyExit を
//    init で受け取り、PTYRegistry にそのまま渡す。WebPage への callJavaScript wire-up は
//    URLSchemeHandler 側 (`RpcSchemeHandler` in `GozdApp.swift`) が実装する。
//
// 5. **戻り値は proto JSON Data**。失敗は throw。URLSchemeHandler 側が HTTP 200 / 4xx / 5xx と
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
  /// PortScanner が検出したサーバー snapshot を renderer に push する callback。
  /// 変化があった scan でのみ呼ばれる (PortScanner 側で差分判定済み)。
  public typealias ServerPortsHandler = @Sendable ([DetectedServer]) -> Void

  // stored properties は extension からも参照されるため module-internal (no modifier)。
  // encapsulation 境界は GozdCore module 自体。type 単位の private は extension 分割と両立しない。
  let pty: PTYRegistry
  let fsWatch: FSWatchRegistry
  let appState: AppStateStore
  let appConfig: AppConfigStore
  let projectConfig: ProjectConfigStore
  let tasks: TaskStore
  let portScanner: PortScanner
  let onHook: HookHandler
  let onOpen: OpenHandler
  let onNotify: NotifyHandler

  public init(
    configDir: String,
    stateDir: String,
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
    onServerPortsChange: @escaping ServerPortsHandler = { _ in },
    envOverlay: GozdEnvOverlay? = nil,
    pidTracker: PidTracker? = nil
  ) {
    let ptyRegistry = PTYRegistry(
      onText: onPtyText, onExit: onPtyExit, envOverlay: envOverlay, pidTracker: pidTracker)
    self.pty = ptyRegistry
    self.portScanner = PortScanner(registry: ptyRegistry, onSnapshot: onServerPortsChange)
    self.fsWatch = FSWatchRegistry(
      onFsChange: onFsChange,
      onGitStatusChange: onGitStatusChange,
      onBranchChange: onBranchChange,
      onRemoteRefsChange: onRemoteRefsChange,
      onWorktreeChange: onWorktreeChange
    )
    self.appState = AppStateStore(stateDir: stateDir)
    self.appConfig = AppConfigStore(configDir: configDir)
    self.projectConfig = ProjectConfigStore(configDir: configDir)
    self.tasks = TaskStore(configDir: configDir)
    self.onHook = onHook
    self.onOpen = onOpen
    self.onNotify = onNotify
  }

  // MARK: - Background services

  /// バックグラウンド常駐サービスを起動する。AppRuntime が page.load 配線後に 1 度呼ぶ。
  /// 現状は PortScanner のポーリング開始のみ。init で自動起動しないのは、テスト等で
  /// dispatcher を構築しただけのときに 3 秒周期の scan を走らせないため。
  public func startServices() async {
    await portScanner.start()
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

  // MARK: - Dispatch

  /// `/path` を handler 関数に振り分ける唯一の SSOT。新規 RPC を追加する時は (1) proto に
  /// request/response を生やす、(2) `RpcDispatcher+<Group>.swift` の extension に handler を
  /// 追加、(3) 本テーブルに `case` を 1 行追加、の 3 ステップで完結する。
  public func dispatch(path: String, body: Data) async throws -> Data {
    switch path {
    case "/echo": return try await handleEcho(body)
    // fs
    case "/fs/readFile": return try handleFsReadFile(body)
    case "/fs/readDir": return try await handleFsReadDir(body)
    case "/fs/watch": return try await handleFsWatch(body)
    case "/fs/unwatch": return try await handleFsUnwatch(body)
    case "/fs/unwatchAll": return try await handleFsUnwatchAll(body)
    case "/fs/readFileAbsolute": return try handleFsReadFileAbsolute(body)
    case "/fs/writeFile": return try handleFsWriteFile(body)
    case "/fs/stat": return try handleFsStat(body)
    // pty
    case "/pty/spawn": return try await handlePtySpawn(body)
    case "/pty/write": return try await handlePtyWrite(body)
    case "/pty/resize": return try await handlePtyResize(body)
    case "/pty/kill": return try await handlePtyKill(body)
    // app state / config
    case "/appState/load": return try handleLoadAppState(body)
    case "/appState/save": return try handleSaveAppState(body)
    case "/appConfig/load": return try handleLoadAppConfig(body)
    case "/appConfig/save": return try handleSaveAppConfig(body)
    case "/projectConfig/load": return try handleProjectConfigLoad(body)
    case "/projectConfig/save": return try handleProjectConfigSave(body)
    // open / window
    case "/open/external": return try handleOpenExternal(body)
    case "/open/file": return try handleOpenFile(body)
    case "/open/pickAndOpen": return try await handlePickAndOpen(body)
    case "/window/close": return try handleWindowClose(body)
    case "/window/setTitleContext": return try await handleWindowSetTitleContext(body)
    case "/window/setServerPanelOpen": return try await handleWindowSetServerPanelOpen(body)

    case "/server/list": return try await handleServerList(body)
    // git (local)
    case "/git/status": return try await handleGitStatus(body)
    case "/git/worktreeList": return try await handleGitWorktreeList(body)
    case "/git/log": return try await handleGitLog(body)
    case "/git/diffHunks": return try await handleGitDiffHunks(body)
    case "/git/diffExpandLines": return try handleGitDiffExpandLines(body)
    case "/git/showFile": return try await handleGitShowFile(body)
    case "/git/showCommitFile": return try await handleGitShowCommitFile(body)
    case "/git/commitFiles": return try await handleGitCommitFiles(body)
    case "/git/prDiffFiles": return try await handleGitPrDiffFiles(body)
    case "/git/readBlob": return try await handleGitReadBlob(body)
    case "/git/revReachable": return try await handleGitRevReachable(body)
    case "/git/mergeBase": return try await handleGitMergeBase(body)
    case "/git/lsTree": return try await handleGitLsTree(body)
    case "/git/resetMixed": return try await handleGitResetMixed(body)
    case "/git/fetchRemotes": return try await handleGitFetchRemotes(body)
    case "/git/defaultBranch": return try await handleGitDefaultBranch(body)
    case "/git/githubIdentity": return try await handleGitGithubIdentity(body)
    case "/git/blameLine": return try await handleGitBlameLine(body)
    case "/git/logLine": return try await handleGitLogLine(body)
    case "/git/logFile": return try await handleGitLogFile(body)
    // gh (GitHub API)
    case "/git/prList": return try await handleGitPrList(body)
    case "/git/issueList": return try await handleGitIssueList(body)
    case "/git/viewer": return try await handleGitViewer(body)
    // worktree
    case "/git/createWorktree": return try await handleCreateWorktree(body)
    case "/git/worktreeRemove": return try await handleWorktreeRemove(body)
    // task
    case "/task/list": return try await handleTaskList(body)
    case "/task/add": return try await handleTaskAdd(body)
    case "/task/setTerminalTitle": return try await handleTaskSetTerminalTitle(body)
    case "/task/setUserTitle": return try await handleTaskSetUserTitle(body)
    case "/task/remove": return try await handleTaskRemove(body)
    case "/task/resumableSessions": return try await handleResumableSessionList(body)
    // claude session
    case "/claudeSession/removeByPty": return try await handleClaudeSessionRemoveByPty(body)
    case "/claudeSession/readLog": return try handleClaudeSessionReadLog(body)
    // shell command (gozd CLI install)
    case "/shellCommand/install": return try handleShellCommandInstall(body)
    case "/shellCommand/uninstall": return try handleShellCommandUninstall(body)
    // voicevox
    case "/voicevox/launch": return try await handleVoicevoxLaunch(body)
    case "/voicevox/checkEngine": return try await handleVoicevoxCheckEngine(body)
    case "/voicevox/listSpeakers": return try await handleVoicevoxListSpeakers(body)
    case "/voicevox/speak": return try await handleVoicevoxSpeak(body)
    default:
      throw RpcError.unknownPath(path)
    }
  }

  // MARK: - Echo (minimal connectivity probe)

  func handleEcho(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_EchoRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_EchoResponse()
    resp.text = "echo: \(req.text)"
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
