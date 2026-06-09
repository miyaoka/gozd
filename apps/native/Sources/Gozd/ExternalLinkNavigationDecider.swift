import AppKit
import Foundation
import GozdCore
import WebKit

/// http(s) かつ非 dev origin への navigation を OS のデフォルトブラウザに渡す NavigationDecider。
/// WWDC25 #231 "Meet WebKit for SwiftUI" が示す `WebPage.NavigationDeciding` 公式パターン。
///
/// NavigationDeciding 未設定では WebView の main frame が外部 URL に置換されようとし、
/// renderer (Vue) を単一 WebPage にロードして UI 全体を構築している gozd では UI 自体が
/// 消える事故になる。これを構造的に防ぐ。
///
/// 判定は **scheme による 3 分岐** で完結する: `<a href>` / `window.open` / `<form action>` /
/// meta refresh / `.reload` など `navigationType` や `action.target` の値には依存しない。
struct ExternalLinkNavigationDecider: WebPage.NavigationDeciding {
  /// dev mode の Vite dev server port ($GOZD_DEV_VITE_PORT)。dev URL は `http://localhost:<port>`
  /// 固定契約なので scheme + host は不要、port だけ env から取る。同一 host:port への自己
  /// navigation は内部とみなして allow する。
  let internalDevPort: Int?

  init() {
    self.internalDevPort = Self.parseInternalDevPort()
  }

  private static func parseInternalDevPort() -> Int? {
    guard let portString = ProcessInfo.processInfo.environment["GOZD_DEV_VITE_PORT"],
      !portString.isEmpty
    else { return nil }
    guard let port = Int(portString) else {
      StderrLog.write(
        tag: "NavigationDecider",
        "GOZD_DEV_VITE_PORT is malformed: \(portString)"
      )
      return nil
    }
    return port
  }

  func decidePolicy(
    for action: WebPage.NavigationAction,
    preferences: inout WebPage.NavigationPreferences
  ) async -> WKNavigationActionPolicy {
    guard let url = action.request.url else { return .allow }
    let scheme = url.scheme?.lowercased()
    let isHTTP = scheme == "http" || scheme == "https"

    // 判定軸は **scheme による 3 分岐** に統一する:
    //   1. http(s) かつ dev mode の Vite dev server origin → 内部扱いで allow
    //   2. http(s) かつそれ以外 → 外部とみなして OS のデフォルトブラウザに渡し cancel
    //   3. それ以外の scheme (`gozd-rpc://` / `gozd-app://` / `about:` / `file:` 等) → allow
    //
    // navigationType (`linkActivated` / `formSubmitted` / `.other` / `.reload` 等) や
    // `action.target` の値に依存しない。renderer は単一 WebPage 上に Vue UI を構築する
    // 設計のため、main frame であれ subframe であれ http(s) への遷移は「OS ブラウザで開く」
    // のがユーザー期待挙動であり、それ以外の経路 (form submit / window.open / meta refresh
    // 等) でも外部 host への遷移は構造的に外部送りで揃える。
    //
    // 起動時の `page.load(http://localhost:$GOZD_DEV_VITE_PORT)` は dev origin allow 経路で透過する。
    if isHTTP {
      if isInternalDevURL(url) {
        return .allow
      }
      await openInDefaultBrowser(url)
      return .cancel
    }

    return .allow
  }

  private func openInDefaultBrowser(_ url: URL) async {
    // `NSWorkspace.shared.open(_:configuration:)` の async 版は launch 失敗時に NSError を
    // throw するため、Bool 版より失敗理由が具体的に残せる (silent drop 禁止規律と整合)。
    let config = NSWorkspace.OpenConfiguration()
    do {
      _ = try await NSWorkspace.shared.open(url, configuration: config)
    } catch {
      StderrLog.write(
        tag: "NavigationDecider",
        "failed to open external URL: \(url.absoluteString): \(error)"
      )
    }
  }

  private func isInternalDevURL(_ url: URL) -> Bool {
    guard let port = internalDevPort else { return false }
    return url.scheme?.lowercased() == "http"
      && url.host == "localhost"
      && url.port == port
  }
}
