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

/// renderer (`window.__gozdReceive`) が一度でも push を受け取れたか。
/// bootstrap 窓 (page ロード済みだが JS bundle 未実行で receiver 未登録) の drop は
/// 期待される正常系なので黙し、ready 到達後の drop だけ「receiver が消えた退行」として
/// ログするための gate。1 プロセス 1 renderer なので MainActor 隔離した単一フラグで足りる。
@MainActor
enum RendererReadiness {
  static var isReady = false
}

/// renderer へ push する唯一の経路。`window.__gozdReceive(type, payload)` を叩く。
/// page == nil（WebPage 未初期化）/ receiver 未登録 / callJavaScript 失敗をすべて
/// stderr にログする。silent drop は禁止: 1 度の取りこぼしで UI 状態が永続的にずれるため、
/// 観察可能性を全 push に必須として課す。
///
/// renderer not ready は 2 段ある:
///   1. page == nil（WebPage 未初期化）
///   2. page はあるが `window.__gozdReceive` 未登録
/// bootstrap 窓では HTML ロード完了（JS context は live）と JS bundle 実行完了
/// （main.ts の `initRpcDispatcher()` が走り receiver 登録）にラグがある。dev では
/// Vite dev server からモジュールグラフを HTTP fetch する分この窓が広く、タイマー駆動の
/// push（PortScanner の serverPortsChange）がこの窓に当たる。callJavaScript は JS context が
/// live なら即実行するため、receiver 未登録時に素で叩くと `__gozdReceive is not a function`
/// の JS 例外になる。receiver の有無を JS 側で判定し、未登録なら drop する
/// （次の周期 push / mount 時 pull hydrate で回収される）。
///
/// ログ方針: receiver 未登録の drop は ready 到達前なら bootstrap 窓の期待される正常系
/// なので黙す（毎起動の startup ノイズを避ける）。一度 ready になった後の drop だけ
/// 「receiver が消えた退行」としてログし観察可能性を残す。
@MainActor
func pushToRenderer(page: WebPage?, type: String, payload: [String: Any]) async {
  guard let page else {
    StderrLog.write(tag: "GozdApp", "push dropped (page not ready): type=\(type)")
    return
  }
  do {
    let delivered = try await page.callJavaScript(
      """
      if (typeof window.__gozdReceive !== "function") return false;
      window.__gozdReceive(type, payload);
      return true;
      """,
      arguments: ["type": type, "payload": payload]
    ) as? Bool ?? false
    if delivered {
      RendererReadiness.isReady = true
      return
    }
    if RendererReadiness.isReady {
      StderrLog.write(tag: "GozdApp", "push dropped (receiver lost): type=\(type)")
    }
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
