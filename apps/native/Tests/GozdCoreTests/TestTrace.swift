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
/// top-level `let` の初期化は Swift runtime が dispatch_once で thread-safe に行うため、
/// 競合や二重発火は起きない。
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

@inline(__always)
func testTrace(_ message: @autoclosure () -> String) {
  guard gozdTraceEnabled else { return }
  _ = _logRunnerEnvironmentOnce
  let testName = Test.current?.name ?? "<no-test>"
  let elapsed = ContinuousClock.now - gozdTraceStart
  gozdTraceLine("[TEST-TRACE +\(elapsed) test=\(testName)] \(message())\n")
}
