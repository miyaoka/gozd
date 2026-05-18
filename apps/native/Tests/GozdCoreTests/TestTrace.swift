import Foundation
import Testing

@testable import GozdCore

// テスト境界 trace。`[TEST-TRACE]` プレフィックスで `gozdTraceLine` に流す。
// `gozdTraceStart` を共有することで `[PTY-TRACE]` と同じ elapsed 時刻になり、
// PTY 内部状態とテスト経路を 1 本のログ stream 上で突き合わせ可能にする。
//
// test 名は `Test.current?.name`（swift-testing が test body 内で参照可能にする
// task-local）から自動取得する。テスト本体に test_id 引数を増やさない設計。
// test body 以外（static init / セットアップ前）から呼ばれた場合は `<no-test>` を出す。

/// 最初の `testTrace` 呼び出し時に CI runner の OS / CPU / host を 1 度だけ log する。
/// 再発時に「同じ runner で再現か / 別 runner か」を切り分ける材料。
/// Swift の global `let` は言語仕様により最初の参照時に thread-safe な lazy 初期化が
/// 1 度だけ走る（並行 access があっても初期化 closure の二重実行は起きない）。
private let _logRunnerEnvironmentOnce: Void = {
  guard gozdTraceEnabled else { return }
  let info = ProcessInfo.processInfo
  let osVersion = info.operatingSystemVersionString
  let cpus = info.processorCount
  let activeCpus = info.activeProcessorCount
  let host = info.hostName
  let elapsed = ContinuousClock.now - gozdTraceStart
  gozdTraceLine(
    "[TEST-TRACE +\(elapsed) test=<runner-env>] os=\(osVersion) cpus=\(cpus) activeCpus=\(activeCpus) host=\(host)\n"
  )
}()

/// テスト本体の最初と最後に呼び、`[TEST-TRACE]` に entry / exit を打つことを推奨する。
/// `Test.current?.name` は test body の直系 thread / task では確実に解決されるため、
/// ここで打った test name は trace ログ単独で pid と test を結びつける唯一の橋になる。
/// `waitUntil` 内 polling やテスト経路途中で取りこぼしが起きても、entry / exit が出ていれば
/// 「この pid を spawn した test はどれか」が直前直後の entry/exit から再構築可能。
///
/// 使い方: 各 test の冒頭で `testTrace("started")` を呼び、その直後に
/// `defer { testTrace("ended") }` を置く。
///
/// **trace key の予約語**: `"started"` / `"ended"` は test entry / exit を示す予約語として扱う。
/// `[TEST-TRACE …] started` / `[TEST-TRACE …] ended` で grep するため、test 内で
/// `testTrace("started …")` のような任意メッセージとしては使わない。
///
/// **defer LIFO 規約**: Swift の `defer` は LIFO で発火する。test 内に追加の `defer` を
/// 書く場合、`defer { testTrace("ended") }` を **test の最初に登録する** ことを推奨する
/// ( = LIFO で最後に発火 )。これにより `[TEST-TRACE … started]` と
/// `[TEST-TRACE … ended]` の間に test 由来のすべての `[PTY-TRACE]` が収まり、解析者は
/// 「started〜ended の区間に出た pid を test に紐付けるだけ」で経路復元が完結する。
///
/// 例外として `defer { Task { … } }` のような **detached cleanup** は test return 後の
/// 非同期 task として走るため、defer 順序にかかわらず ended の trace に間に合わないこと
/// がある。この場合 ended 後の `[PTY-TRACE]` 行は前 test の遅延 cleanup である可能性を
/// 解析者が考慮する必要がある。
@inline(__always)
func testTrace(_ message: @autoclosure () -> String) {
  guard gozdTraceEnabled else { return }
  _ = _logRunnerEnvironmentOnce
  let testName = Test.current?.name ?? "<no-test>"
  let elapsed = ContinuousClock.now - gozdTraceStart
  gozdTraceLine("[TEST-TRACE +\(elapsed) test=\(testName)] \(message())\n")
}
