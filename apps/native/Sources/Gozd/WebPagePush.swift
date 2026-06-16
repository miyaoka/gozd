import Foundation
import GozdCore
import GozdProto
import SwiftUI
import WebKit

// WebPage push の共通経路。dispatcher callback / AppRuntime / その他 module から呼ばれるため、
// `Gozd` target のトップレベルに置く。push 結果は pushToRenderer が stderr にログする
// （詳細なログ方針は同関数の doc を参照）。

// WebPage は @MainActor。dispatcher の callback は background queue から呼ばれるため、
// 弱参照を保持する @MainActor クラスで包んで Task hop で push する。
@MainActor
final class WebPageHolder {
  weak var page: WebPage?
}

/// renderer へ push する唯一の経路。`window.__gozdReceive(type, payload)` を叩く。
///
/// silent drop 禁止規律の根拠は「1 度の取りこぼしで UI 状態が永続的にずれる」こと。
/// 失敗 3 種のうち、この性質を持つ 2 種（page == nil / callJavaScript の JS 例外）は
/// stderr にログする。receiver 未登録だけは別扱い（下記）。
///
/// renderer not ready は 2 段ある:
///   1. page == nil（WebPage 未初期化）
///   2. page はあるが `window.__gozdReceive` 未登録
/// bootstrap 窓では HTML ロード完了（JS context は live）と JS bundle 実行完了
/// （main.ts の `initRpcDispatcher()` が走り receiver 登録）にラグがある。dev では
/// Vite dev server からモジュールグラフを HTTP fetch する分この窓が広く、タイマー駆動の
/// push（PortScanner の serverPortsChange）がこの窓に当たる。callJavaScript は JS context が
/// live なら即実行するため、receiver 未登録時に素で叩くと `__gozdReceive is not a function`
/// の JS 例外になる。receiver の有無を JS 側で判定し、未登録なら黙って drop する。
///
/// receiver 未登録を黙す理由: これは renderer がドキュメント再構築中（起動直後 /
/// dev の Vite フルリロード）という一過性の状態で、その後 renderer は mount で
/// `/server/list` を pull hydrate し onMessage 購読も貼り直すため、この窓で落とした push は
/// 構造的に回復する。「永続的にずれる」性質を持たないので silent drop 禁止規律の対象外。
/// receiver の有無こそ ready の唯一の真実であり、native 側に「過去 ready だったか」の
/// 履歴フラグを持つと、フルリロードのたびに前ドキュメントの ready 状態が残って偽陽性の
/// drop ログを生む（SSOT 違反）。履歴は持たず、毎回 JS 側の bool で現在状態だけを見る。
@MainActor
func pushToRenderer(page: WebPage?, type: String, payload: [String: Any]) async {
  guard let page else {
    StderrLog.write(tag: "GozdApp", "push dropped (page not ready): type=\(type)")
    return
  }
  do {
    // receiver 未登録（false）は一過性なので黙って drop。詳細は doc 参照。
    _ = try await page.callJavaScript(
      """
      if (typeof window.__gozdReceive !== "function") return false;
      window.__gozdReceive(type, payload);
      return true;
      """,
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
