import Darwin
import Foundation
import Testing

@testable import GozdCore

@Suite("SocketServer")
struct SocketServerTests {
  @Test("単一の NDJSON 行を受信できる")
  func receivesSingleLine() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    // issue ( #566 ) 観測: SocketServer suite の `fileExists` polling は CI attempt 1 で
    // `Task.sleep` 経路の stall を踏んだ。GCD ベースの `waitUntilDispatch` に置き換えて、
    // 並列実行下でも tick が発火し続けるかを観測する。
    try await waitUntilDispatch(timeout: .seconds(2)) { fileExists(path) }

    try sendOverUnixSocket(path: path, data: Data(#"{"type":"ping"}\#n"#.utf8))

    try await waitUntilDispatch(timeout: .seconds(2)) { messages.snapshot().count == 1 }
    let received = messages.snapshot()
    #expect(received.count == 1)
    #expect(String(decoding: received[0], as: UTF8.self) == #"{"type":"ping"}"#)
  }

  @Test("1 接続で複数行を順序通りに受信する")
  func receivesMultipleLines() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    try await waitUntilDispatch(timeout: .seconds(2)) { fileExists(path) }

    let payload = Data(
      """
      {"i":1}
      {"i":2}
      {"i":3}

      """.utf8)
    try sendOverUnixSocket(path: path, data: payload)

    try await waitUntilDispatch(timeout: .seconds(2)) { messages.snapshot().count == 3 }
    let received = messages.snapshot().map { String(decoding: $0, as: UTF8.self) }
    #expect(received == [#"{"i":1}"#, #"{"i":2}"#, #"{"i":3}"#])
  }

  @Test("複数接続から並行受信できる")
  func receivesFromMultipleConnections() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    try await waitUntilDispatch(timeout: .seconds(2)) { fileExists(path) }

    try await withThrowingTaskGroup(of: Void.self) { group in
      for i in 0..<5 {
        group.addTask {
          try sendOverUnixSocket(path: path, data: Data(#"{"i":\#(i)}\#n"#.utf8))
        }
      }
      try await group.waitForAll()
    }

    try await waitUntilDispatch(timeout: .seconds(3)) { messages.snapshot().count == 5 }
    let received = Set(messages.snapshot().map { String(decoding: $0, as: UTF8.self) })
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

// `waitUntil` は `WaitUntil.swift` の共有実装を使う（issue #556 観測項目 3）。
// 旧実装は silent return で、timeout 時に Issue.record を呼ばず後段の `#expect` が
// 別症状で間接 fail していた。共有版は tick 履歴を Issue.record の message に inline する。

enum SocketClientError: Error, CustomStringConvertible {
  case createSocket(errno: Int32)
  case pathTooLong
  case connect(errno: Int32)
  case write(errno: Int32)

  var description: String {
    switch self {
    case .createSocket(let e): return "socket() failed: \(String(cString: strerror(e)))"
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

private final class MessageCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var messages: [Data] = []

  func append(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    messages.append(data)
  }

  func snapshot() -> [Data] {
    lock.lock()
    defer { lock.unlock() }
    return messages
  }
}
