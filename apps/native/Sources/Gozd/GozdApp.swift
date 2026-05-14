import Foundation
import GozdCore
import GozdProto
import SwiftUI
import UniformTypeIdentifiers
import WebKit

@main
struct GozdApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate

  var body: some Scene {
    Window(Self.windowTitle, id: "main") {
      ContentView()
        .preferredColorScheme(.dark)
    }
  }

  /// dev / stable をウィンドウタイトルで区別する。判定軸は socketPath / channel と
  /// 同じ `GOZD_DEV_PROJECT_ROOT` の有無に揃える（軸が複数あると drift する）。
  static var windowTitle: String {
    let isDev = (ProcessInfo.processInfo.environment["GOZD_DEV_PROJECT_ROOT"] ?? "").isEmpty == false
    return isDev ? "gozd (dev)" : "gozd"
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    setbuf(stdout, nil)
    setbuf(stderr, nil)
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  /// シングルウィンドウ運用なのでウィンドウを閉じたらアプリも quit する。
  /// macOS の regular app デフォルトは「最後のウィンドウを閉じても dock に残る」
  /// だが、gozd は Window scene 1 つのみなのでウィンドウ消失 = 終了でよい。
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// quit 直前に PTY 子プロセスを SIGHUP で殺す。これを入れないと spawn 中の
  /// zsh / claude などが orphan 化して launchd 配下に残る。
  func applicationWillTerminate(_ notification: Notification) {
    AppRuntime.shared?.terminateAllPtys()
  }
}

struct ContentView: View {
  @State private var runtime = AppRuntime()
  @State private var titleContext = TitleContext.shared

  var body: some View {
    WebView(runtime.page)
      .webViewContentBackground(.hidden)
      .ignoresSafeArea(.container, edges: .top)
      .background(Color.black)
      .toolbar {
        ToolbarItem(placement: .principal) {
          Text(titleContext.text.isEmpty ? GozdApp.windowTitle : titleContext.text)
        }
        .sharedBackgroundVisibility(.hidden)
      }
      .task {
        // 起動時 reconcile を page.load より前に await する。
        // unregisterPane 経路 (/claudeSession/removeByPty) で取りこぼした残骸
        // （クラッシュ等）の最後のセーフティネット。reconcile 完了前に renderer の
        // 初回 listByDir / listByProject が走ると掃除前の claude-sessions.json を
        // 読むため、ここで明示的に順序を保証する。read 時の silent save をやめた
        // 代わりに、起動時 1 回だけ明示的に掃除する設計。
        await runtime.dispatcher.reconcileClaudeSessions()

        // ロード経路は 3 つ:
        //   1. dev: $GOZD_DEV_VITE_URL があれば Vite dev server をロード（HMR）
        //   2. build: gozd-app:// 経由で .app 内 Resources/app/views/main/index.html をロード。
        //      file:// + URLRequest だと WebPage（macOS 26 新 API）に
        //      `loadFileURL(_:allowingReadAccessTo:)` 相当が無く、subresource が
        //      sandbox に阻まれる。WWDC25 公式パターンの URLSchemeHandler 経由にする。
        //   3. fallback: PTY 検証用の埋め込み HTML harness（swift run 直叩き等）
        if let viteURL = ProcessInfo.processInfo.environment["GOZD_DEV_VITE_URL"],
          let url = URL(string: viteURL)
        {
          do {
            for try await _ in runtime.page.load(url) {}
          } catch {
            print("page.load (vite) failed: \(error)")
          }
        } else if BundleAssetSchemeHandler.bundledRoot != nil {
          let appURL = URL(string: "gozd-app://localhost/index.html")!
          do {
            for try await _ in runtime.page.load(URLRequest(url: appURL)) {}
          } catch {
            print("page.load (bundled) failed: \(error)")
          }
        } else {
          let html = ptyHarnessHTML(socketPath: runtime.socketPath)
          do {
            for try await _ in runtime.page.load(
              html: html,
              baseURL: URL(string: "gozd-app://localhost/")!
            ) {}
          } catch {
            print("page.load (harness) failed: \(error)")
          }
        }

        // page load 完了後の起動時 auto-open。
        // CLI 経由 cold start の launch request ファイルがあれば読んで開く。
        // 何もなければ no-op（renderer は前回の sidebar を hydrate して待機）。
        runtime.performInitialOpen()
      }
  }
}

// アプリの runtime 状態。WebPage と SocketServer を 1 つのオブジェクトで束ねる。
//
// 設計判断: @State<class> は SwiftUI 側の更新には乗らないが、ここでは
// 「init で作って後はそのまま」なので問題ない。SocketServer はバックグラウンド
// queue で listen し続けるため、AppRuntime の生存期間がそれを保証する。
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
      FileHandle.standardError.write(
        Data("[ClaudeHooks] settings write failed: \(error)\n".utf8))
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
      let payload: [String: Any] = [
        "dir": dir,
        "statuses": status.statuses,
        "head": status.head,
        "branchHead": status.branchHead,
        "hasUpstream": status.hasUpstream,
        "ahead": Int(status.ahead),
        "behind": Int(status.behind),
      ]
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page, type: "gitStatusChange", payload: payload)
      }
    }
    let onBranchChange: FSWatchRegistry.BranchChangeHandler = { dir, changedRefs in
      Task { @MainActor in
        await pushToRenderer(
          page: holder.page,
          type: "branchChange",
          payload: ["dir": dir, "changedRefs": changedRefs]
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
    // 内部の非同期エラーを renderer に notify push する。
    // - "error" / "info" の type
    // - source は通知元モジュール名（"socket" / "claude-hooks" 等）
    // - detail はスタックトレース相当の生文字列
    let sendNotify:
      @Sendable (String, String, String, String) -> Void = { type, source, message, detail in
        Task { @MainActor in
          await pushToRenderer(
            page: holder.page,
            type: "notify",
            payload: [
              "type": type, "source": source, "message": message, "detail": detail,
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
      onWorktreeChange: onWorktreeChange,
      envOverlay: envOverlay,
      pidTracker: pidTracker
    )
    self.dispatcher = createdDispatcher

    var config = WebPage.Configuration()
    config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler(dispatcher: createdDispatcher)
    config.urlSchemeHandlers[URLScheme("gozd-app")!] = BundleAssetSchemeHandler()
    let page = WebPage(configuration: config)
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
            FileHandle.standardError.write(
              Data("[SocketServer] decode failed: \(error)\n".utf8)
            )
            sendNotify(
              "error", "socket", "Invalid client message", String(describing: error))
          }
        }
      }
      print("[SocketServer] listening on \(socketPath)")
    } catch {
      FileHandle.standardError.write(
        Data("[SocketServer] start failed: \(error)\n".utf8))
      sendNotify(
        "error", "socket", "Failed to start Unix socket server",
        String(describing: error))
    }

    // 起動時に握り潰した Claude hooks settings 書き込みエラーをここで通知する。
    // page.load 前なので即時 push しても renderer は受け取れないが、
    // callJavaScript は WebPage が ready になるまで queue されるため最終的に届く。
    if let err = claudeSettingsWriteError {
      sendNotify(
        "error", "claude-hooks", "Failed to write Claude hooks settings",
        String(describing: err))
    }

    // applicationWillTerminate から PTY を SIGHUP できるよう shared に登録する
    AppRuntime.shared = self
  }

  deinit {
    // SocketServer は deinit で listener.cancel() + unlink するので明示は不要。
  }

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
        cliRunner: "",
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
        cliRunner: "",
        claudeSettingsPath: claudeSettingsPath,
        zdotdir: zdotdir,
        userHome: userHome
      )
    }
    // 最終 fallback: zdotdir を userHome に倒す。Claude hooks は機能しないが PTY は動く。
    return GozdEnvOverlay(
      socketPath: socketPath,
      cliPath: "",
      cliRunner: "",
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

// WebPage は @MainActor。dispatcher の callback は background queue から呼ばれるため、
// 弱参照を保持する @MainActor クラスで包んで Task hop で push する。
@MainActor
final class WebPageHolder {
  weak var page: WebPage?
}

/// renderer へ push する唯一の経路。`window.__gozdReceive(type, payload)` を叩く。
/// page == nil（WebPage 未初期化）と callJavaScript 失敗の両方を stderr にログする。
/// silent drop は禁止: 1 度の取りこぼしで UI 状態が永続的にずれるため、
/// 観察可能性を全 push に必須として課す。
@MainActor
func pushToRenderer(page: WebPage?, type: String, payload: [String: Any]) async {
  guard let page else {
    FileHandle.standardError.write(
      Data("[GozdApp] push dropped (page not ready): type=\(type)\n".utf8))
    return
  }
  do {
    _ = try await page.callJavaScript(
      "window.__gozdReceive(type, payload)",
      arguments: ["type": type, "payload": payload]
    )
  } catch {
    FileHandle.standardError.write(
      Data("[GozdApp] push failed: type=\(type) error=\(error)\n".utf8))
  }
}

private func encodeExitReason(_ reason: PTYExitReason) -> [String: Any] {
  switch reason {
  case .exited(let code):
    return ["kind": "exited", "exitCode": Int(code)]
  case .signaled(let signal, let coreDumped):
    return ["kind": "signaled", "signal": Int(signal), "coreDumped": coreDumped]
  case .stopped:
    return ["kind": "stopped"]
  case .waitpidFailed(let errno):
    return ["kind": "waitpidFailed", "errno": Int(errno)]
  }
}

// HTTP-style 包装を担当する URLSchemeHandler。実際の RPC ロジックは RpcDispatcher。
struct RpcSchemeHandler: URLSchemeHandler {
  let dispatcher: RpcDispatcher

  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        let body = request.httpBody ?? Data()

        do {
          let respData = try await dispatcher.dispatch(path: url.path, body: body)
          let httpResp = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            ]
          )!
          continuation.yield(.response(httpResp))
          continuation.yield(.data(respData))
        } catch RpcError.unknownPath(let p) {
          yield(continuation: continuation, status: 404, url: url, message: "unknown RPC: \(p)")
        } catch {
          yield(continuation: continuation, status: 500, url: url, message: "\(error)")
        }
        continuation.finish()
      }
    }
  }

  private func yield(
    continuation: AsyncThrowingStream<URLSchemeTaskResult, any Error>.Continuation,
    status: Int,
    url: URL,
    message: String
  ) {
    let httpResp = HTTPURLResponse(
      url: url,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      ]
    )!
    continuation.yield(.response(httpResp))
    continuation.yield(.data(Data(message.utf8)))
  }
}

enum SchemeError: Error {
  case missingURL
}

// `gozd-app://localhost/<path>` を Bundle.main/Contents/Resources/app/views/main/<path> にマップする。
// 新 SwiftUI WebPage API には `loadFileURL(_:allowingReadAccessTo:)` 相当が無く、
// file:// 直ロードでは subresource（/assets/*.js 等）が WKWebView sandbox に弾かれる。
// WWDC25「Meet WebKit for SwiftUI」が示す公式パターンに従い、custom scheme で serve する。
struct BundleAssetSchemeHandler: URLSchemeHandler {
  /// `.app` 内 renderer 配置ルート。Bundle が無い（swift run 直叩き等）と nil。
  static var bundledRoot: URL? {
    Bundle.main.resourceURL?.appendingPathComponent("app/views/main", isDirectory: true)
  }

  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        guard let root = Self.bundledRoot else {
          continuation.finish(throwing: URLError(.fileDoesNotExist))
          return
        }
        let relPath = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let normalized = relPath.isEmpty ? "index.html" : relPath
        // path traversal 防止: `..` を含むパスを standardized で正規化し、symlink を
        // 解決した実体パスが bundledRoot 配下にあることを確認する。`gozd-app://` は
        // renderer から fetch 可能なため、XSS 経由で bundle 外を読まれないようにする。
        let candidate = root.appendingPathComponent(normalized).standardized
        let resolvedFile = candidate.resolvingSymlinksInPath()
        let resolvedRoot = root.resolvingSymlinksInPath()
        let rootPath = resolvedRoot.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard resolvedFile.path == rootPath || resolvedFile.path.hasPrefix(prefix) else {
          continuation.finish(throwing: URLError(.fileDoesNotExist))
          return
        }
        let fileURL = candidate
        do {
          let data = try Data(contentsOf: fileURL)
          let mime =
            UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
          let resp = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime, "Content-Length": "\(data.count)"]
          )!
          continuation.yield(.response(resp))
          continuation.yield(.data(data))
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
    }
  }
}

// Phase 3 検証用ハーネス。xterm.js + 単一 PTY + UTF-8 境界ストレステスト + Socket inbound。
private func ptyHarnessHTML(socketPath: String) -> String {
  let userHome = FileManager.default.homeDirectoryForCurrentUser.path
  return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
      <style>
        body { font-family: -apple-system, sans-serif; margin: 0; padding: 12px; background: #1e1e1e; color: #eee; }
        .row { margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        button { padding: 6px 10px; font-size: 13px; }
        #term { background: #000; padding: 4px; height: 380px; }
        .status { font-size: 12px; color: #888; }
        h2 { font-size: 13px; margin: 16px 0 4px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; }
        #socketLog { background: #111; border: 1px solid #333; padding: 6px; font-family: Menlo, monospace; font-size: 11px; height: 140px; overflow: auto; white-space: pre-wrap; }
        code { background: #111; padding: 2px 4px; border-radius: 3px; font-size: 11px; }
      </style>
    </head>
    <body>
      <h2>PTY</h2>
      <div class="row">
        <button onclick="ptySpawn()">spawn /bin/zsh</button>
        <button onclick="ptyKill()" id="killBtn" disabled>kill (SIGHUP)</button>
        <span class="status" id="status">no pty</span>
      </div>
      <div class="row">
        <button onclick="stress('emoji')">stress: 100k 🍣</button>
        <button onclick="stress('mixed')">stress: 50k mixed</button>
        <button onclick="stress('cjk')">stress: 100k CJK</button>
        <button onclick="echoMb()">echo 日本語🍣</button>
      </div>
      <div id="term"></div>

      <h2>Socket inbound (Unix Domain Socket NDJSON)</h2>
      <div class="row">
        <span class="status">socket: <code id="sockPath">\(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"hook":{"event":"session-start","ptyId":1}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"open":{"targetPath":"/path/to/repo"}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div id="socketLog"></div>

      <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
      <script>
        const term = new Terminal({
          fontFamily: 'Menlo, monospace',
          fontSize: 12,
          theme: { background: '#000000', foreground: '#dddddd' },
          cursorBlink: true,
          convertEol: false,
          scrollback: 10000,
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const termEl = document.getElementById('term');
        term.open(termEl);
        fit.fit();
        term.focus();
        termEl.addEventListener('click', () => term.focus());

        let currentPtyId = null;

        async function rpc(path, body) {
          const res = await fetch(`gozd-rpc://localhost${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`RPC ${path} failed: ${res.status} ${text}`);
          }
          return res.json();
        }

        async function ptySpawn() {
          if (currentPtyId !== null) return;
          term.reset();
          term.options.cursorBlink = true;
          const env = {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            HOME: '\(userHome)',
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          };
          const out = await rpc('/pty/spawn', {
            dir: '\(userHome)',
            executable: '/bin/zsh',
            args: ['/bin/zsh', '-i'],
            env,
            rows: term.rows,
            cols: term.cols,
          });
          currentPtyId = Number(out.ptyId);
          document.getElementById('status').textContent = 'pty id=' + currentPtyId;
          document.getElementById('killBtn').disabled = false;
        }

        async function ptyKill() {
          if (currentPtyId === null) return;
          await rpc('/pty/kill', { ptyId: currentPtyId });
        }

        async function ptyWriteText(s) {
          if (currentPtyId === null) return;
          const bytes = new TextEncoder().encode(s);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          await rpc('/pty/write', { ptyId: currentPtyId, data: btoa(bin) });
        }

        term.onData((s) => { ptyWriteText(s); });

        async function echoMb() {
          await ptyWriteText('echo 日本語あいうえお🍣🍱🍙🍡\\n');
        }

        async function stress(kind) {
          let cmd = '';
          if (kind === 'emoji') {
            cmd = `python3 -c "import sys; sys.stdout.write('🍣' * 100000)"\\n`;
          } else if (kind === 'mixed') {
            cmd = `python3 -c "import sys; sys.stdout.write(('あいうえお🍣 sushi 寿司🍱🍙🍡🍵 hello world\\\\n') * 50000)"\\n`;
          } else if (kind === 'cjk') {
            cmd = `python3 -c "import sys; sys.stdout.write('一二三四五六七八九十' * 10000)"\\n`;
          }
          await ptyWriteText(cmd);
        }

        const socketLog = document.getElementById('socketLog');
        function logSocket(line) {
          const ts = new Date().toISOString().slice(11, 23);
          socketLog.textContent = `[${ts}] ${line}\\n` + socketLog.textContent;
        }

        window.__gozdReceive = function(type, payload) {
          if (type === 'ptyText') {
            if (payload.id !== currentPtyId) return;
            term.write(payload.text);
          } else if (type === 'ptyExit') {
            const r = payload.reason;
            const desc = r.kind === 'exited'
              ? `exit code ${r.exitCode}`
              : r.kind === 'signaled'
                ? `killed by signal ${r.signal}${r.coreDumped ? ' (core)' : ''}`
                : `stopped`;
            term.write(`\\r\\n\\x1b[33m[pty:${payload.id} ${desc}]\\x1b[0m\\r\\n`);
            term.options.cursorBlink = false;
            if (payload.id === currentPtyId) {
              currentPtyId = null;
              document.getElementById('status').textContent = 'no pty';
              document.getElementById('killBtn').disabled = true;
            }
          } else if (type === 'hook') {
            logSocket('hook ' + JSON.stringify(payload));
          } else if (type === 'gozdOpen') {
            logSocket('gozdOpen ' + JSON.stringify(payload));
          }
        };

        window.addEventListener('resize', () => {
          fit.fit();
          if (currentPtyId !== null) {
            rpc('/pty/resize', { ptyId: currentPtyId, rows: term.rows, cols: term.cols });
          }
        });
      </script>
    </body>
    </html>
    """
}
