import Foundation
import GozdCore
import SwiftUI
import WebKit

// SwiftUI アプリのエントリポイント。@main App + AppDelegate + ContentView の 3 要素のみ。
// runtime 状態 (WebPage / SocketServer / RpcDispatcher 等) は `AppRuntime.swift`、push utility は
// `WebPagePush.swift`、URL scheme handler は `RpcSchemeHandler.swift` /
// `BundleAssetSchemeHandler.swift` 側に分離している。

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
            StderrLog.write(tag: "GozdApp", "page.load (vite) failed: \(error)")
          }
        } else if BundleAssetSchemeHandler.bundledRoot != nil {
          let appURL = URL(string: "gozd-app://localhost/index.html")!
          do {
            for try await _ in runtime.page.load(URLRequest(url: appURL)) {}
          } catch {
            StderrLog.write(tag: "GozdApp", "page.load (bundled) failed: \(error)")
          }
        } else {
          let html = ptyHarnessHTML(socketPath: runtime.socketPath)
          do {
            for try await _ in runtime.page.load(
              html: html,
              baseURL: URL(string: "gozd-app://localhost/")!
            ) {}
          } catch {
            StderrLog.write(tag: "GozdApp", "page.load (harness) failed: \(error)")
          }
        }

        // page load 完了後の起動時 auto-open。
        // CLI 経由 cold start の launch request ファイルがあれば読んで開く。
        // 何もなければ no-op（renderer は前回の sidebar を hydrate して待機）。
        runtime.performInitialOpen()
      }
  }
}
