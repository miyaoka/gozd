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
      rootView
    }
  }

  /// dev タイトルバーの識別色。「insiders ビルド = 緑」の業界慣習 (VS Code Insiders) に
  /// 合わせた、彩度・明度を抑えた緑 (hue 140°)。renderer の success token (緑) と色相が
  /// 近いが、titlebar という UI 外周での識別色なので意味の衝突は許容する判断。
  private static let devTitlebarTint = Color(
    hue: 140.0 / 360.0, saturation: 0.35, brightness: 0.40)

  /// dev 起動時のみタイトルバー (window toolbar) の背景を識別色に塗る。stable は素のまま。
  ///
  /// Liquid Glass の公式ガイドは toolbar への custom background を非推奨とするが、
  /// 代替の公式パターン「`toolbarBackgroundVisibility(.hidden)` で背景を消して
  /// コンテンツに描かせる」(Destination Video) は gozd では成立しない。WebKit `WebPage` は
  /// macOS で titlebar 高を `env(safe-area-inset-top)` としてコンテンツへ伝えず (実測 0)、
  /// renderer が reservation を取れないため、title 行がコンテンツに重なって崩壊する。
  /// dev channel 限定の識別色として、ガイド非推奨を許容して塗る判断を取った。
  @ViewBuilder
  private var rootView: some View {
    let base = ContentView().preferredColorScheme(.dark)
    if Self.isDev {
      // .visible を明示して tint の常時表示を確定させる。`toolbarBackground(色)` 単独だと
      // 「システムが必要と判断したときのみ」適用で、表示がシステム裁量に依存する。
      // toolbarColorScheme は tint 上の title 文字色契約をこの分岐内で固定するため
      // （preferredColorScheme 経由の暗黙依存に頼らない）。
      base
        .toolbarBackground(Self.devTitlebarTint, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
        .toolbarColorScheme(.dark, for: .windowToolbar)
    } else {
      base
    }
  }

  /// dev / stable の判定。判定軸は socketPath / channel と同じ
  /// `GOZD_DEV_PROJECT_ROOT` の有無に揃える（軸が複数あると drift する）。
  static var isDev: Bool {
    (ProcessInfo.processInfo.environment["GOZD_DEV_PROJECT_ROOT"] ?? "").isEmpty == false
  }

  /// dev / stable をウィンドウタイトルで区別する。
  static var windowTitle: String {
    isDev ? "gozd (dev)" : "gozd"
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
    // top safe area の扱いは channel で分岐する。
    // - stable: titlebar 下まで WebView を延ばす。Liquid Glass titlebar が WebView の
    //   背景輝度をサンプルし、コンテンツと同調した dark になる（従来挙動）。respect に
    //   変えると glass が下の `.background(Color.black)` を拾い、titlebar だけ黒く浮く
    // - dev: `.toolbarBackground` 塗りで titlebar 高が不透明な top inset になるため
    //   respect する。無視すると WebView 上端が不透明 titlebar の真下に隠れて壊れる
    WebView(runtime.page)
      .webViewContentBackground(.hidden)
      .ignoresSafeArea(.container, edges: GozdApp.isDev ? [] : .top)
      .background(Color.black)
      .toolbar {
        ToolbarItem(placement: .principal) {
          Text(titleContext.text.isEmpty ? GozdApp.windowTitle : titleContext.text)
        }
        .sharedBackgroundVisibility(.hidden)
      }
      .task {
        // ロード経路は 3 つ:
        //   1. dev: $GOZD_DEV_VITE_PORT があれば Vite dev server (http://localhost:<port>) をロード（HMR）
        //   2. build: gozd-app:// 経由で .app 内 Resources/app/views/main/index.html をロード。
        //      file:// + URLRequest だと WebPage（macOS 26 新 API）に
        //      `loadFileURL(_:allowingReadAccessTo:)` 相当が無く、subresource が
        //      sandbox に阻まれる。WWDC25 公式パターンの URLSchemeHandler 経由にする。
        //   3. fallback: PTY 検証用の埋め込み HTML harness（swift run 直叩き等）
        if let portString = ProcessInfo.processInfo.environment["GOZD_DEV_VITE_PORT"],
          !portString.isEmpty,
          let url = URL(string: "http://localhost:\(portString)/")
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
