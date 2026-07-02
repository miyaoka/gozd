import Darwin
import Foundation
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

    try sendOverUnixSocket(path: path, data: Data(#"{"type":"ping"}\#n"#.utf8))

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
    try sendOverUnixSocket(path: path, data: payload)

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
          try sendOverUnixSocket(path: path, data: Data(#"{"i":\#(i)}\#n"#.utf8))
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

enum SocketClientError: Error, CustomStringConvertible {
  case createSocket(errno: Int32)
  case setNoSigpipe(errno: Int32)
  case pathTooLong
  case connect(errno: Int32)
  case write(errno: Int32)

  var description: String {
    switch self {
    case .createSocket(let e): return "socket() failed: \(String(cString: strerror(e)))"
    case .setNoSigpipe(let e):
      return "setsockopt(SO_NOSIGPIPE) failed: \(String(cString: strerror(e)))"
    case .pathTooLong: return "socket path too long"
    case .connect(let e): return "connect() failed: \(String(cString: strerror(e)))"
    case .write(let e): return "write() failed: \(String(cString: strerror(e)))"
    }
  }
}

/// 本番 CLI（GozdCLI.sendOrExit）と同じ POSIX socket + write-all + shutdown(SHUT_WR) +
/// drain パターンの test helper。NWConnection の `contentProcessed` 後に即 cancel すると
/// NWListener が accept する前に FIN が届いて受信されない race（spike `gozd-spike` で
/// 検証済み）が起き、CI で flaky に取りこぼす原因になる。production と同じ手順に揃える。
private func sendOverUnixSocket(path: String, data: Data) throws {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { throw SocketClientError.createSocket(errno: errno) }
  defer { close(fd) }

  // SO_NOSIGPIPE: peer (server) が connection を close / reset した後の write は、
  // これが無いと EPIPE ではなく SIGPIPE をプロセス全体に配送する (default action は
  // terminate)。swift-testing は全 suite を単一プロセスで並列実行するため、1 回の
  // race で swiftpm-testing-helper ごと signal 13 死し、全テストが巻き添えになる
  // (CI でのみ再現する flaky crash の正体)。設定後は EPIPE が返り、下の write-all
  // loop が SocketClientError.write として観察可能に throw する。
  var noSigpipe: Int32 = 1
  guard
    setsockopt(
      fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size)) == 0
  else { throw SocketClientError.setNoSigpipe(errno: errno) }

  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
  guard pathBytes.count <= maxLen else { throw SocketClientError.pathTooLong }
  withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    let buf = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
    for (i, byte) in pathBytes.enumerated() {
      buf[i] = CChar(bitPattern: byte)
    }
    buf[pathBytes.count] = 0
  }
  let connectResult = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
      Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if connectResult < 0 { throw SocketClientError.connect(errno: errno) }

  // write-all（部分書き込みに loop 対応）
  try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
    var remaining = buf.count
    var ptr = buf.baseAddress!
    while remaining > 0 {
      let written = Darwin.write(fd, ptr, remaining)
      if written < 0 {
        if errno == EINTR { continue }
        throw SocketClientError.write(errno: errno)
      }
      remaining -= written
      ptr = ptr.advanced(by: written)
    }
  }

  // shutdown(SHUT_WR) → drain。server 側が EOF まで読み取るのを待つ。
  shutdown(fd, Int32(SHUT_WR))
  var drainBuf = [UInt8](repeating: 0, count: 256)
  while true {
    let n = drainBuf.withUnsafeMutableBufferPointer {
      Darwin.read(fd, $0.baseAddress, $0.count)
    }
    if n > 0 { continue }
    if n < 0, errno == EINTR { continue }
    break
  }
}

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
