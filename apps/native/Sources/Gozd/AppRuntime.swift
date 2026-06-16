import Foundation
import GozdCore
import GozdProto
import SwiftUI
import WebKit

// アプリの runtime 状態。WebPage と SocketServer と RpcDispatcher を 1 つのオブジェクトで束ねる。
//
// 設計判断:
//
// 1. **@State<class> は SwiftUI 側の更新には乗らない**が、ここでは「init で作って後はそのまま」
//    なので問題ない。SocketServer はバックグラウンド queue で listen し続けるため、AppRuntime
//    の生存期間がそれを保証する。
//
// 2. **callback の wiring を init に集約**。dispatcher の各 push callback (onPtyText / onHook /
//    onFsChange 等) は WebPageHolder の weak 参照を closure capture して `pushToRenderer` に
//    流す。Holder を間に挟むのは WebPage が @MainActor で、background callback から直接触れない
//    ため Task @MainActor で hop する必要があるから。
//
// 3. **dev / build channel 判別は `GOZD_DEV_PROJECT_ROOT` の有無で 1 軸**に揃える。socketPath /
//    Claude settings path / env overlay の解決軸が drift しないようにする。

@MainActor
final class AppRuntime {
  /// AppDelegate.applicationWillTerminate から PTY 子プロセスを SIGHUP するために
  /// 同期的にアクセスできる shared 参照を持つ。init で代入される。
  static var shared: AppRuntime?

  let page: WebPage
  let server: SocketServer
  let socketPath: String
  let pidTracker: PidTracker
  let channel: String
  let dispatcher: RpcDispatcher

  /// AppDelegate.applicationWillTerminate から呼ばれる。同期実行で SIGHUP を送る。
  func terminateAllPtys() {
    pidTracker.killAll()
  }

  /// 起動時に渡された initial open target を解決して push する。
  ///   1. CLI cold start: $TMPDIR/gozd-{channel}-launch/ 配下の launch request
  ///      ファイル（最古のもの）を読んで開き、対象ファイルを削除する
  ///   2. それ以外: no-op（renderer は OpenMessage が来るまで待機）
  ///
  /// dev 起動時の `GOZD_DEV_PROJECT_ROOT` は zsh init / CLI ソース解決と
  /// channel 判別のためだけに使う。初期 open に流用すると worktree から
  /// `pnpm dev` するたびに toplevel が変わり、sidebar に同名 repo が増殖する。
  func performInitialOpen() {
    if let target = AppRuntime.consumeLaunchRequest(channel: channel) {
      openTarget(target)
    }
  }

  /// 任意の path を gozdOpen event として renderer に push する。
  /// CLI / socket 経由の OpenMessage と、起動時の launch request 経由の cold
  /// start open の共通エントリポイント。
  func openTarget(_ targetPath: String) {
    let channel = self.channel
    let page = self.page
    Task { @MainActor in
      let payload = await AppRuntime.buildGozdOpenPayload(
        targetPath: targetPath, channel: channel)
      await pushToRenderer(page: page, type: "gozdOpen", payload: payload)
    }
  }

  init() {
    let socketPath = AppRuntime.defaultSocketPath()
    self.socketPath = socketPath
    let pidTracker = PidTracker()
    self.pidTracker = pidTracker
    let channel = AppRuntime.channelFromSocketPath(socketPath)
    self.channel = channel
    let holder = WebPageHolder()

    // Claude hooks settings JSON を $TMPDIR に書き出す。
    // PTY の zsh init で `claude` 関数がこのパスを `--settings` に注入する。
    let claudeSettingsPath = AppRuntime.claudeSettingsPath(channel: channel)
    let claudeSettingsWriteError: Error?
    do {
      try ClaudeHooksSettings.write(to: claudeSettingsPath)
      claudeSettingsWriteError = nil
    } catch {
      claudeSettingsWriteError = error
      StderrLog.write(tag: "ClaudeHooks", "settings write failed: \(error)")
    }

    // dev / build 共通の env overlay。dev では GOZD_DEV_PROJECT_ROOT 配下のソースを参照する。
    let envOverlay = AppRuntime.makeEnvOverlay(
      socketPath: socketPath, claudeSettingsPath: claudeSettingsPath)

    // WebPage push 用 callback。background queue から呼ばれるため Task @MainActor で hop。
    let onPtyText: @Sendable (UInt32, String) -> Void = { id, text in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "ptyText",
          payload: ["id": Int(id), "text": text]
        )
      }
    }
    let onPtyExit: @Sendable (UInt32, PTYExitReason) -> Void = { id, reason in
      let reasonPayload = encodeExitReason(reason)
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "ptyExit",
          payload: ["id": Int(id), "reason": reasonPayload]
        )
      }
    }
    let onHook: @Sendable (Gozd_V1_HookMessage) -> Void = { hook in
      // sessionId は renderer 側で task (= session) ↔ ptyId マッピングを成立させるために必要
      let payload: [String: Any] = [
        "event": hook.event,
        "ptyId": Int(hook.ptyID),
        "sessionId": hook.sessionID,
        "lastAssistantMessage": hook.lastAssistantMessage,
        "toolName": hook.toolName,
        "toolInput": hook.toolInput,
        "isInterrupt": hook.isInterrupt,
      ]
      Task { @MainActor in
        await pushToRenderer(page: holder.page, type: "hook", payload: payload)
      }
    }
    let onOpen: @Sendable (String) -> Void = { targetPath in
      Task { @MainActor in
        let payload = await AppRuntime.buildGozdOpenPayload(
          targetPath: targetPath, channel: channel)
        await pushToRenderer(page: holder.page, type: "gozdOpen", payload: payload)
      }
    }

    let onFsChange: FSWatchRegistry.FsChangeHandler = { dir, relDir in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "fsChange",
          payload: ["dir": dir, "relDir": relDir]
        )
      }
    }
    let onGitStatusChange: FSWatchRegistry.GitStatusChangeHandler = { dir, status in
      var payload: [String: Any] = [
        "dir": dir,
        "statuses": status.statuses,
        "renameOldPaths": status.renameOldPaths,
        "head": status.head,
        "branchHead": status.branchHead,
        "latestMtime": Int(status.latestMtime),
      ]
      // upstream 未設定なら upstream フィールドごと不在にする。renderer 側は
      // `upstream === undefined` を「ahead/behind を読まない」契約として扱う。
      if status.hasUpstream {
        payload["upstream"] = [
          "ahead": Int(status.ahead),
          "behind": Int(status.behind),
        ]
      }
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page, type: "gitStatusChange", payload: payload)
      }
    }
    let onBranchChange: FSWatchRegistry.BranchChangeHandler = { dir in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "branchChange",
          payload: ["dir": dir]
        )
      }
    }
    let onRemoteRefsChange: FSWatchRegistry.RemoteRefsChangeHandler = { dir in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "remoteRefsChange",
          payload: ["dir": dir]
        )
      }
    }
    let onWorktreeChange: FSWatchRegistry.WorktreeChangeHandler = { dir in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "worktreeChange",
          payload: ["dir": dir]
        )
      }
    }
    // PortScanner が検出したサーバー snapshot を renderer に push する。
    // 全件 snapshot (差分ではなく毎回全件)。renderer 側は latest-wins で置換する。
    // wire shape は server.proto の ServerEntry を手組み dict で写す (events 系と同流儀)。
    let onServerPortsChange: RpcDispatcher.ServerPortsHandler = { servers in
      let payload: [String: Any] = [
        "servers": servers.map { server in
          [
            "pid": Int(server.pid),
            "name": server.name,
            "ports": server.ports.map { Int($0) },
            "attribution": server.attribution.rawValue,
            "worktreePath": server.worktreePath,
            "ptyId": Int(server.ptyId),
          ] as [String: Any]
        }
      ]
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page, type: "serverPortsChange", payload: payload)
      }
    }
    // 内部の非同期エラーを renderer に notify push する。
    // - "error" / "info" の type
    // - source は通知元モジュール名（"socket" / "claude-hooks" / "task-store" 等）
    // - detail はスタックトレース相当の生文字列
    // - dir は失敗の発生源 worktree path / project anchor dir。renderer 側が
    //   `findRepoOwning(dir)` で repo を特定して該当 repo だけ refetch する手がかり。
    //   rollback 対象 source ("task-store" / "claude-sessions") は必ず非空 dir を渡す。
    //   それ以外 ("socket" / "claude-hooks" 等経路に紐付かない通知) は空文字でよく、
    //   購読側 (useSidebarData) は空文字を skip して fan-out しない。
    let sendNotify:
      @Sendable (String, String, String, String, String) -> Void = {
        type, source, message, detail, dir in
        Task { @MainActor in
          await pushToRenderer(
            page: holder.page,
            type: "notify",
            payload: [
              "type": type, "source": source, "message": message, "detail": detail, "dir": dir,
            ]
          )
        }
      }

    let createdDispatcher = RpcDispatcher(
      configDir: AppRuntime.defaultConfigDir(),
      onPtyText: onPtyText,
      onPtyExit: onPtyExit,
      onHook: onHook,
      onOpen: onOpen,
      onFsChange: onFsChange,
      onGitStatusChange: onGitStatusChange,
      onBranchChange: onBranchChange,
      onRemoteRefsChange: onRemoteRefsChange,
      onWorktreeChange: onWorktreeChange,
      onNotify: sendNotify,
      onServerPortsChange: onServerPortsChange,
      envOverlay: envOverlay,
      pidTracker: pidTracker
    )
    self.dispatcher = createdDispatcher

    // バックグラウンド常駐サービス (PortScanner) を起動する。dispatcher 構築後に 1 度だけ。
    Task { await createdDispatcher.startServices() }

    var config = WebPage.Configuration()
    config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler(dispatcher: createdDispatcher)
    config.urlSchemeHandlers[URLScheme("gozd-app")!] = BundleAssetSchemeHandler()
    // preview の image / SVG `<img src>` 経路。proto を bytes 対応に破壊変更せず、
    // raw bytes は WebKit に直接食わせる方針。詳細は FileServerSchemeHandler.swift 冒頭参照。
    config.urlSchemeHandlers[URLScheme("gozd-file")!] = FileServerSchemeHandler()
    // 外部リンク (`<a target="_blank">` / `window.open`) を OS のブラウザに渡す。
    // 未設定だと主フレームを置換しようとして renderer の UI 全体が消える。
    let page = WebPage(configuration: config, navigationDecider: ExternalLinkNavigationDecider())
    page.isInspectable = true
    holder.page = page
    self.page = page

    // SocketServer 起動。受信した NDJSON 行を dispatcher に流す。
    // decode 失敗（不正 JSON / oneof 未指定）は stderr にログするだけで
    // 接続は維持する（CLI 側のバグで server が落ちないように）。
    let server = SocketServer(socketPath: socketPath)
    self.server = server
    do {
      try server.start { line in
        Task {
          do {
            try await createdDispatcher.handleSocketMessage(line)
          } catch {
            StderrLog.write(tag: "SocketServer", "decode failed: \(error)")
            sendNotify(
              "error", "socket", "Invalid client message", String(describing: error), "")
          }
        }
      }
      StderrLog.write(tag: "SocketServer", "listening on \(socketPath)")
    } catch {
      StderrLog.write(tag: "SocketServer", "start failed: \(error)")
      sendNotify(
        "error", "socket", "Failed to start Unix socket server",
        String(describing: error), "")
    }

    // 起動時に握り潰した Claude hooks settings 書き込みエラーをここで通知する。
    // page.load 前なので即時 push しても renderer は受け取れないが、
    // callJavaScript は WebPage が ready になるまで queue されるため最終的に届く。
    if let err = claudeSettingsWriteError {
      sendNotify(
        "error", "claude-hooks", "Failed to write Claude hooks settings",
        String(describing: err), "")
    }

    // applicationWillTerminate から PTY を SIGHUP できるよう shared に登録する
    AppRuntime.shared = self
  }

  deinit {
    // SocketServer は deinit で listener.cancel() + unlink するので明示は不要。
  }

  // MARK: - path resolvers

  /// `~/.config/gozd`。dev/stable で同じパスを使う。worktree 本体
  /// （`~/.local/share/gozd/worktrees/`）が channel 共有なのと同じく、
  /// app state / config / Task / ProjectConfig も同じものを共有する。
  private static func defaultConfigDir() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".config/\(bundlePrefix)").path
  }

  /// socket / settings / launch dir / Bundle ID で共有する prefix。
  /// architecture.md の規約に従い `$TMPDIR/{bundlePrefix}-{channel}.sock` 等で使う。
  static let bundlePrefix = "gozd"

  private static func defaultSocketPath() -> String {
    // architecture.md の規約: $TMPDIR/{bundlePrefix}-{channel}.sock。
    // dev / stable は GOZD_DEV_PROJECT_ROOT の有無で判別（dev script が必ず設定する）。
    let tmp = NSTemporaryDirectory()
    let env = ProcessInfo.processInfo.environment
    let isDev = (env["GOZD_DEV_PROJECT_ROOT"] ?? "").isEmpty == false
    let channel = isDev ? "dev" : "stable"
    return (tmp as NSString).appendingPathComponent("\(bundlePrefix)-\(channel).sock")
  }

  /// CLI が cold start 時に書き出した launch request ファイルを 1 件読んで
  /// targetPath を返し、当該ファイルを削除する。複数あれば最古のもの。
  fileprivate static func consumeLaunchRequest(channel: String) -> String? {
    let tmp = NSTemporaryDirectory()
    let ch = channel.isEmpty ? "dev" : channel
    let dir = (tmp as NSString).appendingPathComponent("\(bundlePrefix)-\(ch)-launch")
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: dir), !entries.isEmpty else {
      return nil
    }
    // 作成時刻順に並べて最古を採る
    let sorted = entries.sorted { lhs, rhs in
      let lp = (dir as NSString).appendingPathComponent(lhs)
      let rp = (dir as NSString).appendingPathComponent(rhs)
      let la = (try? fm.attributesOfItem(atPath: lp))?[.creationDate] as? Date
      let ra = (try? fm.attributesOfItem(atPath: rp))?[.creationDate] as? Date
      return (la ?? .distantPast) < (ra ?? .distantPast)
    }
    guard let first = sorted.first else { return nil }
    let path = (dir as NSString).appendingPathComponent(first)
    defer { try? fm.removeItem(atPath: path) }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let target = json["targetPath"] as? String
    else {
      return nil
    }
    return target
  }

  /// $TMPDIR/gozd-{channel}-claude-settings.json。Claude Code の `--settings` に渡す。
  fileprivate static func claudeSettingsPath(channel: String) -> String {
    let tmp = NSTemporaryDirectory()
    let ch = channel.isEmpty ? "dev" : channel
    return (tmp as NSString).appendingPathComponent("\(bundlePrefix)-\(ch)-claude-settings.json")
  }

  /// dev / build 環境を判別して GozdEnvOverlay を組み立てる。
  /// - dev: `GOZD_DEV_PROJECT_ROOT` 配下の zsh init / CLI ソースを参照、runner=`bun`
  /// - build: TODO（Phase 4）。現状は dev でない場合 zdotdir/cliPath を空にして
  ///   overlay を返す（PTY は動くが claude hooks が機能しない）
  fileprivate static func makeEnvOverlay(
    socketPath: String, claudeSettingsPath: String
  ) -> GozdEnvOverlay {
    let env = ProcessInfo.processInfo.environment
    let userHome = FileManager.default.homeDirectoryForCurrentUser.path
    if let projectRoot = env["GOZD_DEV_PROJECT_ROOT"], !projectRoot.isEmpty {
      let zdotdir = (projectRoot as NSString).appendingPathComponent("apps/native/Resources/zsh")
      // Swift 版 CLI バイナリを優先する。`pnpm --filter @gozd/native dev` 内で
      // `swift build --product gozd-cli` が事前に走り `.build/debug/gozd-cli` を生成する。
      let cliPath =
        (projectRoot as NSString).appendingPathComponent(
          "apps/native/.build/debug/gozd-cli")
      return GozdEnvOverlay(
        socketPath: socketPath,
        cliPath: cliPath,
        claudeSettingsPath: claudeSettingsPath,
        zdotdir: zdotdir,
        userHome: userHome
      )
    }
    // build モード: .app バンドル内 Resources/app/{bin,zsh} を参照する。
    // build-app.sh が以下のレイアウトで配置している:
    //   <.app>/Contents/Resources/app/bin/gozd-cli
    //   <.app>/Contents/Resources/app/zsh/.zshrc 等
    if let resourceURL = Bundle.main.resourceURL {
      let appResource = resourceURL.appendingPathComponent("app")
      let cliPath = appResource.appendingPathComponent("bin/gozd-cli").path
      let zdotdir = appResource.appendingPathComponent("zsh").path
      return GozdEnvOverlay(
        socketPath: socketPath,
        cliPath: cliPath,
        claudeSettingsPath: claudeSettingsPath,
        zdotdir: zdotdir,
        userHome: userHome
      )
    }
    // 最終 fallback: zdotdir を userHome に倒す。Claude hooks は機能しないが PTY は動く。
    return GozdEnvOverlay(
      socketPath: socketPath,
      cliPath: "",
      claudeSettingsPath: claudeSettingsPath,
      zdotdir: userHome,
      userHome: userHome
    )
  }

  /// `/tmp/{bundlePrefix}-dev.sock` → `dev` のように socket basename からチャネル名を抽出。
  /// 規約: `{bundlePrefix}-{channel}.sock`。マッチしない場合は空文字列を返し、renderer 側で
  /// channel が空のままになる（appStore.setChannel が no-op）。
  fileprivate static func channelFromSocketPath(_ path: String) -> String {
    let base = (path as NSString).lastPathComponent
    let prefix = "\(bundlePrefix)-"
    guard base.hasPrefix(prefix), base.hasSuffix(".sock") else { return "" }
    let start = base.index(base.startIndex, offsetBy: prefix.count)
    let end = base.index(base.endIndex, offsetBy: -".sock".count)
    return String(base[start..<end])
  }

  /// OpenMessage.targetPath を gozdOpen event payload に変換する。
  /// - git repo 内のパスなら `git rev-parse --show-toplevel` で repo root を解決し、
  ///   そのディレクトリ名を repoName として使う。
  /// - git 管理外のパスなら targetPath をそのまま dir として使い、isGitRepo=false。
  /// - file 指定（targetPath が file）の場合、selection を埋めて dir は parent にする。
  fileprivate static func buildGozdOpenPayload(
    targetPath: String, channel: String
  ) async -> [String: Any] {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    let exists = fm.fileExists(atPath: targetPath, isDirectory: &isDir)

    let probeDir: String
    var selection: [String: Any] = [:]
    if exists, !isDir.boolValue {
      // ファイル指定 → parent を dir にして selection を埋める
      let parent = (targetPath as NSString).deletingLastPathComponent
      probeDir = parent
      selection = [
        "kind": "file",
        "relPath": (targetPath as NSString).lastPathComponent,
        "lineNumber": 0,
      ]
    } else {
      probeDir = targetPath
    }

    var dir = probeDir
    var repoName = (probeDir as NSString).lastPathComponent
    var isGitRepo = false
    var resolverError: String?
    // `commandFailed`（probeDir が git 管理外 / detached HEAD 等のドメイン失敗）は
    // `isGitRepo = false` で扱う既存挙動を維持する。`launchFailed`（git CLI 解決失敗、
    // すなわち `CommandResolver` がユーザーシェル経由で git を見つけられない病的環境）は
    // payload に `error` キーを積んで renderer に通知し、`useGozdOpenHandler` 側で
    // `notify.error` を出させる。`try?` で両者を一律 nil 化すると、Finder 起動の `.app` で
    // 静かに「git repo ではない」扱いに化けるため新契約と片肺になる。
    do {
      let toplevel = try await GitOps.repoTopLevel(dir: probeDir)
      if !toplevel.isEmpty {
        dir = toplevel
        isGitRepo = true
        // worktree から開いた場合 toplevel はその worktree 自身（gozd の場合 timestamp 名）。
        // 表示用 repoName は main repo の basename を使う（git-common-dir の親）。
        // 失敗時のみ toplevel basename にフォールバック。
        do {
          let mainRoot = try await GitOps.mainRepoRoot(dir: probeDir)
          repoName =
            mainRoot.isEmpty
            ? (toplevel as NSString).lastPathComponent
            : (mainRoot as NSString).lastPathComponent
        } catch GitError.commandFailed {
          repoName = (toplevel as NSString).lastPathComponent
        }
        // file 指定で probeDir が toplevel と異なる場合、selection.relPath を toplevel
        // からの相対パスに更新する
        if !selection.isEmpty, probeDir != toplevel {
          let absFile = (probeDir as NSString).appendingPathComponent(
            selection["relPath"] as? String ?? "")
          if absFile.hasPrefix(toplevel) {
            let rel = String(absFile.dropFirst(toplevel.count))
            selection["relPath"] = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
          }
        }
      }
    } catch GitError.launchFailed(let message) {
      resolverError = message
    } catch GitError.commandFailed {
      // 非 git ディレクトリ / detached HEAD など。isGitRepo = false のまま続行。
    } catch {
      // CancellationError 等の想定外。renderer に通知し isGitRepo = false で続行。
      resolverError = String(describing: error)
    }

    var payload: [String: Any] = [
      "dir": dir,
      "channel": channel,
      "repoName": repoName,
      "isGitRepo": isGitRepo,
      "switchToDir": "",
    ]
    if !selection.isEmpty {
      payload["selection"] = selection
    }
    if let resolverError {
      payload["error"] = resolverError
    }
    return payload
  }
}
