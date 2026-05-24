import Foundation
import Testing

@testable import GozdCore

// `condition()` が true になるまで小さくポーリングで待つ test 共有 helper。
//
// 実装契約:
//
// - polling loop ( condition 評価 / trace 出力 / `Thread.sleep(forTimeInterval:)` ) は
//   `Thread { ... }.start()` で立てた **dedicated NSThread** 上で完結する。Swift Concurrency
//   の cooperative executor 経路を一切踏まないため、`Task.sleep` 経由で発火する
//   executor 固有 stall の影響を受けない。`withCheckedContinuation` の resume は polling
//   終了 ( resolved / timeout ) 時の 1 回のみ
// - GCD pool も使わないため `Thread.sleep` の blocking が他 GCD 処理 ( SocketServer 専用
//   queue 含め `DispatchQueue.global()` worker pool に依存する全経路 ) を阻害しない
// - `condition` は **同期的に評価できる predicate に限定** する ( `await` を含む condition は
//   渡してはいけない )。NSThread 上で評価されるため `await` を呼ぶと再び cooperative
//   executor に hop する。本 helper 利用 test の condition ( `fileExists` /
//   `MessageCollector.snapshot()` / `ExitCollector.snapshot()` / `events.exitedIds()` 等 ) は
//   すべて NSLock ベースで同期完結する
// - 本 helper は **cancel に応答しない** ( `throws` を返さず `Task.checkCancellation` も
//   呼ばない )。外側 Task が cancel されても polling は timeout まで継続する。NSThread を
//   `cancel()` で止める分岐は trace 解析の余計なノイズになるため採用しない
// - timeout 時は `Issue.record` で test を fail させる。silent return すると後段の
//   `#expect` が別の症状で間接 fail し、timeout だった事象が trace から追跡できなくなる
//
// trace 出力 ( `[TEST-TRACE]` プレフィックス、`gozdTraceStart` を共有 ):
//
//   - entry: `waitUntil entered timeout=... desc=...`
//   - tick:  `waitUntil tick=<n> elapsed=<dur> wall=<sec> result=<bool>`
//   - 成功:  `waitUntil resolved tick=<n> elapsed=<dur>`
//   - timeout: `waitUntil timeout tickCount=<n> elapsed=<dur> lastTicks=[...]`
//
// 直近 10 tick の polling 履歴を保持し、timeout 時に `Issue.record` の message に inline
// する。50ms poll × 10 = 直近 0.5s 分の挙動が CI ログを遡らずに失敗メッセージから読める。
//
// `wall=<Date.timeIntervalSinceReferenceDate>` を併記し、`ContinuousClock`
// ( `mach_continuous_time` 基盤、suspend 中も進む ) と `Date` ( system clock、NTP 調整 ) を
// 並列に記録する。稀な system clock 異常 ( NTP 巻き戻し / sleep wake 後の補正 ) の検知用。

func waitUntil(
  timeout: Duration,
  description: String = "condition",
  _ condition: @escaping @Sendable () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  testTrace("waitUntil entered timeout=\(timeout) desc=\(description)")
  let result: WaitResult = await withCheckedContinuation { continuation in
    let thread = Thread {
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
        threadTrace(
          "tick=\(tickCount) elapsed=\(elapsed) wall=\(wall) result=\(condResult)")
        if condResult {
          threadTrace("resolved tick=\(tickCount) elapsed=\(elapsed)")
          continuation.resume(returning: .resolved)
          return
        }
        threadTrace("before-sleep tick=\(tickCount)")
        Thread.sleep(forTimeInterval: 0.050)
        threadTrace("after-sleep tick=\(tickCount)")
      }
      let finalElapsed = ContinuousClock.now - started
      let historyText = tickHistory
        .map { "\($0.elapsed):\($0.result)" }
        .joined(separator: ", ")
      threadTrace(
        "timeout tickCount=\(tickCount) elapsed=\(finalElapsed) lastTicks=[\(historyText)]")
      continuation.resume(
        returning: .timeout(elapsed: finalElapsed, tickCount: tickCount, history: historyText))
    }
    thread.name = "WaitUntil"
    thread.start()
  }
  switch result {
  case .resolved:
    return
  case .timeout(let elapsed, let tickCount, let history):
    Issue.record(
      """
      waitUntil timed out after \(timeout) waiting for: \(description). \
      elapsed=\(elapsed) tickCount=\(tickCount). \
      last ticks: [\(history)]
      """,
      sourceLocation: sourceLocation)
  }
}

/// NSThread closure からの trace。`Test.current` は Swift Concurrency の TaskLocal で
/// NSThread 上では nil になるため、`testTrace` ではなく `gozdTraceLine` を直接呼んで
/// `<no-test>` ではなく `<threaded>` タグで出す。
private func threadTrace(_ message: String) {
  guard gozdTraceEnabled else { return }
  let elapsed = ContinuousClock.now - gozdTraceStart
  let testName = Test.current?.name ?? "<threaded>"
  gozdTraceLine("[TEST-TRACE +\(elapsed) test=\(testName)] waitUntil \(message)\n")
}

private enum WaitResult {
  case resolved
  case timeout(elapsed: Duration, tickCount: Int, history: String)
}
