import Foundation
import Testing

// PTYManagerTests / PTYRegistryTests で共有する条件待機ヘルパー。
//
// 旧実装は各テストファイルに `private func waitUntil` を重複定義しており、
// timeout 時に「いつから condition が false だったか」が分からなかった（issue #556 観測項目 3）。
// 本実装は tick ごとの condition 結果を直近 10 件保持し、timeout 時に Issue.record の
// failure メッセージに inline する。CI ログを遡らずに失敗メッセージから 2 秒分の polling
// 推移が読めるようにするのが目的。
//
// 加えて `[TEST-TRACE]` で entry / tick / resolve / timeout を stderr に流すため、
// 同じ ContinuousClock 基準を持つ `[PTY-TRACE]` と時系列を突き合わせ可能になる。

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
///   - tick: `waitUntil tick=<n> elapsed=<dur> result=<bool>`
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
    let result = condition()
    tickCount += 1
    tickHistory.append((elapsed, result))
    if tickHistory.count > historyCap {
      tickHistory.removeFirst(tickHistory.count - historyCap)
    }
    testTrace("waitUntil tick=\(tickCount) elapsed=\(elapsed) result=\(result)")
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
