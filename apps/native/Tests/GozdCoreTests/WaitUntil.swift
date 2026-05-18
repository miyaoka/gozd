import Foundation
import Testing

// PTYManagerTests / PTYRegistryTests / SocketServerTests で共有する条件待機ヘルパー。
//
// 旧実装は各テストファイルに `private func waitUntil` を重複定義しており、
// timeout 時に「いつから condition が false だったか」が分からなかった（issue #556 観測項目 3）。
// 本実装は tick ごとの condition 結果を直近 10 件保持し、timeout 時に Issue.record の
// failure メッセージに inline する。CI ログを遡らずに失敗メッセージから 2 秒分の polling
// 推移が読めるようにするのが目的。
//
// 加えて `[TEST-TRACE]` で entry / tick / resolve / timeout を stderr に流すため、
// 同じ ContinuousClock 基準を持つ `[PTY-TRACE]` と時系列を突き合わせ可能になる。
//
// issue ( #566 ) 観測項目:
//
// - tick trace 行に `wall=<Date 秒>` を併記する。ContinuousClock (mach_continuous_time 基盤、
//   suspend 中も進む) と Date (system clock、NTP 調整あり) を並列に記録し、CPU steal /
//   VM freeze で両者が同時に止まる経路と、cooperative executor だけが止まる経路を区別する。
//
// - `waitUntilDispatch` を追加する。GCD `asyncAfter` ベースの polling で、Task / async-await
//   経路ではなく DispatchQueue.global() の thread pool 上で再開する。`Task.sleep` 経由の
//   `waitUntil` と並走させた結果、片方だけが stall するか / 両方同時に stall するかで、
//   stall の経路が (i) Swift Concurrency runtime 固有か (ii) OS scheduler 全体停止か
//   を切り分ける。同 elapsed 基準 / 同 stderr lock を共有する `[TEST-TRACE-DISPATCH]`
//   prefix で出すため、grep で 2 系統に分離可能。

/// `condition()` が true を返すまで小さくポーリングで待つ。timeout 到達時に
/// `Issue.record` で test を fail させる。silent return すると後段の `#expect` が
/// 別の症状（exit が nil など）で間接 fail し、timeout だった事象を追跡できなくなる。
///
/// - Parameters:
///   - timeout: 待機の上限。超過時に Issue.record。
///   - description: timeout 失敗メッセージに含める「何を待っていたか」の説明。
///   - condition: 各 tick で評価する条件。`@Sendable` な capture のみ可。
///
/// trace 出力:
///   - entry: `waitUntil entered timeout=... desc=...`
///   - tick: `waitUntil tick=<n> elapsed=<dur> wall=<sec> result=<bool>`
///   - 成功: `waitUntil resolved tick=<n> elapsed=<dur>`
///   - timeout: `waitUntil timeout tickCount=<n> elapsed=<dur> lastTicks=[...]`
func waitUntil(
  timeout: Duration,
  description: String = "condition",
  _ condition: @escaping @Sendable () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async throws {
  let started = ContinuousClock.now
  let deadline = started.advanced(by: timeout)
  testTrace("waitUntil entered timeout=\(timeout) desc=\(description)")
  // 直近 N tick の polling 推移を保持。`N=10` は 50ms poll × 10 = 0.5s 分。
  // 2 秒 timeout の場合「終端直前 0.5 秒の挙動」が再構築できれば
  // 「開始直後から nil で固定」/「最後の数 tick だけ nil」の区別が付く。
  let historyCap = 10
  var tickHistory: [(elapsed: Duration, result: Bool)] = []
  var tickCount = 0
  while ContinuousClock.now < deadline {
    let elapsed = ContinuousClock.now - started
    let wall = Date().timeIntervalSinceReferenceDate
    let result = condition()
    tickCount += 1
    tickHistory.append((elapsed, result))
    if tickHistory.count > historyCap {
      tickHistory.removeFirst(tickHistory.count - historyCap)
    }
    testTrace("waitUntil tick=\(tickCount) elapsed=\(elapsed) wall=\(wall) result=\(result)")
    if result {
      testTrace("waitUntil resolved tick=\(tickCount) elapsed=\(elapsed)")
      return
    }
    try await Task.sleep(for: .milliseconds(50))
  }
  let elapsed = ContinuousClock.now - started
  let historyText = tickHistory
    .map { "\($0.elapsed):\($0.result)" }
    .joined(separator: ", ")
  testTrace(
    "waitUntil timeout tickCount=\(tickCount) elapsed=\(elapsed) lastTicks=[\(historyText)]")
  Issue.record(
    """
    waitUntil timed out after \(timeout) waiting for: \(description). \
    elapsed=\(elapsed) tickCount=\(tickCount). \
    last \(tickHistory.count) ticks: [\(historyText)]
    """,
    sourceLocation: sourceLocation)
}

/// `waitUntil` の GCD ( `DispatchQueue.global().asyncAfter` ) ベース版。
///
/// 観測目的: issue ( #566 ) の stall window ( CI attempt 1 で `+0.002s〜+2.04s` の間
/// `Task.sleep(50ms)` が一度も resume しなかった ) が、cooperative executor 固有か
/// OS scheduler 全体停止かを切り分ける。本関数は `Task.sleep` を経由せず GCD の
/// `asyncAfter` で next tick を schedule するため:
///
/// - (i) Swift Concurrency runtime / cooperative executor 固有の stall なら、本関数の
///   tick は stall window 中も発火し続ける ( = `waitUntil` だけが詰まり、本関数は通常通り )
/// - (ii) OS scheduler 全体停止 ( CPU steal / VM freeze ) なら、GCD thread pool も
///   同じ OS scheduler に依存するため、本関数も同時刻に stall する
///
/// trace prefix は `[TEST-TRACE]` のままで、内容に `waitUntilDispatch` を含めることで
/// grep で `waitUntil` と分離可能にする。
///
/// 失敗時 ( timeout 到達 / condition が `await` を必要とする等 ) の規律は `waitUntil` と
/// 同一: silent return せず `Issue.record` で test を fail させる。
func waitUntilDispatch(
  timeout: Duration,
  description: String = "condition",
  _ condition: @escaping @Sendable () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async throws {
  let started = ContinuousClock.now
  let deadline = started.advanced(by: timeout)
  testTrace("waitUntilDispatch entered timeout=\(timeout) desc=\(description)")
  let historyCap = 10
  var tickHistory: [(elapsed: Duration, result: Bool)] = []
  var tickCount = 0
  while ContinuousClock.now < deadline {
    let elapsed = ContinuousClock.now - started
    let wall = Date().timeIntervalSinceReferenceDate
    let result = condition()
    tickCount += 1
    tickHistory.append((elapsed, result))
    if tickHistory.count > historyCap {
      tickHistory.removeFirst(tickHistory.count - historyCap)
    }
    testTrace(
      "waitUntilDispatch tick=\(tickCount) elapsed=\(elapsed) wall=\(wall) result=\(result)")
    if result {
      testTrace("waitUntilDispatch resolved tick=\(tickCount) elapsed=\(elapsed)")
      return
    }
    try await dispatchSleep(milliseconds: 50)
  }
  let elapsed = ContinuousClock.now - started
  let historyText = tickHistory
    .map { "\($0.elapsed):\($0.result)" }
    .joined(separator: ", ")
  testTrace(
    "waitUntilDispatch timeout tickCount=\(tickCount) elapsed=\(elapsed) lastTicks=[\(historyText)]"
  )
  Issue.record(
    """
    waitUntilDispatch timed out after \(timeout) waiting for: \(description). \
    elapsed=\(elapsed) tickCount=\(tickCount). \
    last \(tickHistory.count) ticks: [\(historyText)]
    """,
    sourceLocation: sourceLocation)
}

/// `DispatchQueue.global().asyncAfter` で `milliseconds` 後に resume する。
/// `Task.sleep` は cooperative executor 経路で sleep するが、本関数は GCD thread pool
/// 上で resume する。issue ( #566 ) の stall 経路切り分けに使う。
///
/// `withCheckedContinuation` で continuation の resume を GCD に委譲する。
/// continuation の race は GCD `asyncAfter` が単一発火を保証するため起きない。
private func dispatchSleep(milliseconds: Int) async throws {
  try Task.checkCancellation()
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(milliseconds)) {
      continuation.resume()
    }
  }
}
