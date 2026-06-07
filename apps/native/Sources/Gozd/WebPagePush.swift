import Foundation
import GozdCore
import GozdProto
import SwiftUI
import WebKit

// WebPage push の共通経路。dispatcher callback / AppRuntime / その他 module から呼ばれるため、
// `Gozd` target のトップレベルに置く。silent drop 禁止規律として page == nil /
// callJavaScript 失敗の両方を必ず stderr にログする (1 度の取りこぼしで UI 状態が永続的にずれる)。

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
    StderrLog.write(tag: "GozdApp", "push dropped (page not ready): type=\(type)")
    return
  }
  do {
    _ = try await page.callJavaScript(
      "window.__gozdReceive(type, payload)",
      arguments: ["type": type, "payload": payload]
    )
  } catch {
    StderrLog.write(tag: "GozdApp", "push failed: type=\(type) error=\(error)")
  }
}

/// PTYExitReason を renderer の JSON payload に写す。`exitCode` / `signal` / `errno` 等を
/// kind で分岐する discriminated union 形式。renderer 側は kind switch で扱う契約。
func encodeExitReason(_ reason: PTYExitReason) -> [String: Any] {
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
