import Darwin
import Foundation
import GozdSocketClient
import Testing

@testable import GozdCore

// `.timeLimit(.minutes(1))` は production 側 bug (SocketServer の listener が起動しない
// deadlock 等) で test が永久 hang するのを test framework 経由の fail に倒す breaker。
// 個別 test の経験則 timeout を排し suite 単位 1 段に集約 (issue #710 系譜)。
@Suite("SocketServer", .timeLimit(.minutes(1)))
struct SocketServerTests {
  @Test("単一の NDJSON 行を受信できる")
  func receivesSingleLine() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let bridge = SocketMessageBridge()
    let server = SocketServer(socketPath: path)
    try server.start(onMessage: bridge.onMessage)
    defer { server.stop() }

    // socket file 出現待ち = kqueue / syscall 経路で SUT 側に callback accessor が無い。
    // WaitUntil.swift 規律「使用可: OS event の到達待ち」に該当 (issue #710 系譜)。
    await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    try sendOverUnixSocket(path: path, payload: Data(#"{"type":"ping"}\#n"#.utf8))

    let received = await bridge.collect(count: 1)
    #expect(received.count == 1)
    #expect(String(decoding: received[0], as: UTF8.self) == #"{"type":"ping"}"#)
  }

  @Test("1 接続で複数行を順序通りに受信する")
  func receivesMultipleLines() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let bridge = SocketMessageBridge()
    let server = SocketServer(socketPath: path)
    try server.start(onMessage: bridge.onMessage)
    defer { server.stop() }

    // socket file 出現待ち (上の test と同じ規律)。
    await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    let payload = Data(
      """
      {"i":1}
      {"i":2}
      {"i":3}

      """.utf8)
    try sendOverUnixSocket(path: path, payload: payload)

    let received = await bridge.collect(count: 3).map { String(decoding: $0, as: UTF8.self) }
    #expect(received == [#"{"i":1}"#, #"{"i":2}"#, #"{"i":3}"#])
  }

  @Test("複数接続から並行受信できる")
  func receivesFromMultipleConnections() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let bridge = SocketMessageBridge()
    let server = SocketServer(socketPath: path)
    try server.start(onMessage: bridge.onMessage)
    defer { server.stop() }

    // socket file 出現待ち (上の test と同じ規律)。
    await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    try await withThrowingTaskGroup(of: Void.self) { group in
      for i in 0..<5 {
        group.addTask {
          try sendOverUnixSocket(path: path, payload: Data(#"{"i":\#(i)}\#n"#.utf8))
        }
      }
      try await group.waitForAll()
    }

    let received = Set(
      await bridge.collect(count: 5).map { String(decoding: $0, as: UTF8.self) })
    let expected: Set<String> = (0..<5).map { #"{"i":\#($0)}"# }.reduce(into: Set()) {
      $0.insert($1)
    }
    #expect(received == expected)
  }
}

// MARK: - Helpers

/// Unix socket path 上限（macOS sun_path[104]）に収まる短いテスト用 path を作る。
private func makeSocketPath() -> String {
  let short = String(UUID().uuidString.prefix(8))
  return NSTemporaryDirectory() + "gozd-test-\(short).sock"
}

private func fileExists(_ path: String) -> Bool {
  var st = stat()
  return stat(path, &st) == 0
}

// `waitUntil` は `WaitUntil.swift` の共有実装 ( dedicated NSThread 上で polling loop を完結 )。
// timeout 時に `Issue.record` で tick 履歴を message に inline する。

// 送信は本番 CLI（GozdCLI.sendOrExit）と同一実装の `GozdSocketClient.sendOverUnixSocket` を
// 使う。shutdown + drain 手順が必要な理由は SocketClient.swift の module コメントを参照。

/// SocketServer の message callback を AsyncStream に直結する test 用 bridge。
///
/// 設計目的:
///   - 過去設計 (MessageCollector + NSLock + waitUntil polling) は production callback を
///     mutable snapshot に変換し、50ms tick で polling する確率的経路
///   - 本 bridge は callback を AsyncStream に直結し、`collect(count:)` で N 件到達まで
///     決定的に await する。polling 0 段、timeout 0 段
///   - 永久 suspend は suite trait `.timeLimit(.minutes(1))` が breaker として吸収する
///
/// **単一 consumer 契約**: `stream` は 1 度だけ iterate すること (`collect(count:)` 1 回
/// または `for await` 1 回)。AsyncStream は single-consumer 契約のため 2 度目の iteration
/// は未定義動作 (Apple Doc: "iterating an `AsyncStream` more than once results in undefined
/// behavior")。複数 phase の message 観察には別 bridge インスタンスを使う。
private final class SocketMessageBridge: Sendable {
  let onMessage: @Sendable (Data) -> Void
  let stream: AsyncStream<Data>

  init() {
    let (stream, continuation) = AsyncStream<Data>.makeStream()
    self.stream = stream
    self.onMessage = { continuation.yield($0) }
    // continuation.finish() は collect 側で打ち切る (server は test 終了まで生きる)。
  }

  /// 指定件数の message が到達するまで `for await` で待つ。順序は callback 配送順と一致。
  func collect(count: Int) async -> [Data] {
    var collected: [Data] = []
    for await data in stream {
      collected.append(data)
      if collected.count >= count { break }
    }
    return collected
  }
}
