import Foundation
import Testing

@testable import GozdCore

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
// - tick trace 行に `wall=<Date 秒>` を併記する。`ContinuousClock`
//   ( `mach_continuous_time` 基盤、suspend 中も進む ) と `Date` ( system clock、NTP 調整 )
//   を並列に記録し、稀な system clock 異常 ( NTP 巻き戻し / sleep wake 後の補正 ) と
//   通常の単調進行を区別する保険として残す。(i)/(ii) 切り分けの主軸ではない。
//
// - `waitUntilThreaded` を追加する。`DispatchQueue.global().async` で polling loop **全体**
//   ( condition 評価 / trace 出力 / sleep ) を GCD thread 上で完結させ、`withCheckedContinuation`
//   の resume は polling 終了 ( resolved / timeout ) 時のみ呼ぶ。これにより polling loop の
//   実行 thread が Swift Concurrency の cooperative executor から完全に外れる。
//
//   先行版の `waitUntilDispatch` ( CI run 26029332080 attempt 1 で実証 ) は `withCheckedContinuation`
//   経由で sleep の wait phase だけを GCD に逃がし、resume 後の polling iteration が
//   cooperative executor に hop して戻る構造だった。結果 `Task.sleep` 経路と同じ stall
//   window で詰まり、(i) cooperative executor 固有 stall / (ii) OS scheduler 全体停止 の
//   切り分けに不十分だった。`waitUntilThreaded` はこの設計欠陥を構造的に解消する版。
//
//   期待される観測:
//   - (i) cooperative executor 固有が真: `waitUntilThreaded` の tick は stall window 中も
//     50ms 間隔で発火、同 window で `waitUntil` ( Task.sleep 経路 ) だけが詰まる
//   - (ii) OS scheduler 全体停止が真: `waitUntilThreaded` も同 window で詰まる
//
// 重複の意図: `waitUntil` と `waitUntilThreaded` は polling loop の構造がほぼ同一だが、
// 観測 PR の独立性 ( 片方を変更しても他方が影響を受けない保証 ) を保つため敢えて重複させる。
// 観測終了後の fix PR で一本化するかは別判断。

/// `condition()` が true を返すまで小さくポーリングで待つ ( `Task.sleep` 経路 )。
/// timeout 到達時に `Issue.record` で test を fail させる。silent return すると後段の
/// `#expect` が別の症状（exit が nil など）で間接 fail し、timeout だった事象を追跡
/// できなくなる。
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
    testTrace("waitUntil before-sleep tick=\(tickCount)")
    try await Task.sleep(for: .milliseconds(50))
    testTrace("waitUntil after-sleep tick=\(tickCount)")
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

/// `waitUntil` の **polling loop 全体を GCD thread 上で完結** させる版。Swift Concurrency
/// の cooperative executor 経路を完全に外し、`Task.sleep` 経路で詰まる stall ( CI run
/// 26029332080 attempt 1 で観測 ) との切り分けに使う。
///
/// 実装上の契約:
///
/// - polling loop ( condition 評価 / trace 出力 / `Thread.sleep` ) は `DispatchQueue.global().async`
///   の closure 内で 1 つの GCD worker thread 上に閉じる。`withCheckedContinuation` の
///   resume は polling 終了時 ( resolved / timeout ) の **1 回のみ**
/// - `condition` は **同期的に評価できる predicate に限定** する ( `await` を含む condition は
///   渡してはいけない )。内部で async を呼ぶと再び cooperative executor に hop して観測精度が
///   失われる。本 PR 対象 5 test の condition ( `fileExists` / `MessageCollector.snapshot()` /
///   `ExitCollector.snapshot()` / `events.exitedIds()` ) はすべて同期完結する NSLock ベースで
///   契約を満たす
/// - `Issue.record` は cooperative executor / GCD どちらの thread からも呼べる
///
/// trace 出力は `[TEST-TRACE]` 共有 + 行内 `waitUntilThreaded` で grep 分離可能。
/// `waitUntil` と同じ tick / before-sleep / after-sleep の粒度で出す。
func waitUntilThreaded(
  timeout: Duration,
  description: String = "condition",
  _ condition: @escaping @Sendable () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  testTrace("waitUntilThreaded entered timeout=\(timeout) desc=\(description)")
  let result: ThreadedWaitResult = await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
      let started = ContinuousClock.now
      let deadline = started.advanced(by: timeout)
      let historyCap = 10
      var tickHistory: [(elapsed: Duration, result: Bool)] = []
      var tickCount = 0
      while ContinuousClock.now < deadline {
        let elapsed = ContinuousClock.now - started
        let wall = Date().timeIntervalSinceReferenceDate
        let condResult = condition()
        tickCount += 1
        tickHistory.append((elapsed, condResult))
        if tickHistory.count > historyCap {
          tickHistory.removeFirst(tickHistory.count - historyCap)
        }
        threadedTrace(
          "tick=\(tickCount) elapsed=\(elapsed) wall=\(wall) result=\(condResult)")
        if condResult {
          threadedTrace("resolved tick=\(tickCount) elapsed=\(elapsed)")
          continuation.resume(returning: .resolved)
          return
        }
        threadedTrace("before-sleep tick=\(tickCount)")
        Thread.sleep(forTimeInterval: 0.050)
        threadedTrace("after-sleep tick=\(tickCount)")
      }
      let finalElapsed = ContinuousClock.now - started
      let historyText = tickHistory
        .map { "\($0.elapsed):\($0.result)" }
        .joined(separator: ", ")
      threadedTrace(
        "timeout tickCount=\(tickCount) elapsed=\(finalElapsed) lastTicks=[\(historyText)]")
      continuation.resume(
        returning: .timeout(elapsed: finalElapsed, tickCount: tickCount, history: historyText))
    }
  }
  switch result {
  case .resolved:
    return
  case .timeout(let elapsed, let tickCount, let history):
    Issue.record(
      """
      waitUntilThreaded timed out after \(timeout) waiting for: \(description). \
      elapsed=\(elapsed) tickCount=\(tickCount). \
      last ticks: [\(history)]
      """,
      sourceLocation: sourceLocation)
  }
}

/// `waitUntilThreaded` 内 GCD thread からの trace は `Test.current` が解決できる保証が
/// 無いため、`testTrace` ではなく `gozdTraceLine` を直接呼んで `<no-test>` 経由ではなく
/// `<threaded>` タグで吐く。GCD thread と `Test.current` の TaskLocal の関係は未保証。
private func threadedTrace(_ message: String) {
  guard gozdTraceEnabled else { return }
  let elapsed = ContinuousClock.now - gozdTraceStart
  let testName = Test.current?.name ?? "<threaded>"
  gozdTraceLine("[TEST-TRACE +\(elapsed) test=\(testName)] waitUntilThreaded \(message)\n")
}

private enum ThreadedWaitResult {
  case resolved
  case timeout(elapsed: Duration, tickCount: Int, history: String)
}
