import Darwin
import Foundation
import Network
import Testing

@testable import GozdCore

@Suite("SocketServer")
struct SocketServerTests {
  @Test("単一の NDJSON 行を受信できる")
  func receivesSingleLine() async throws {
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    try await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    sendOverUnixSocket(path: path, data: Data(#"{"type":"ping"}\#n"#.utf8))

    try await waitUntil(timeout: .seconds(2)) { messages.snapshot().count == 1 }
    let received = messages.snapshot()
    #expect(received.count == 1)
    #expect(String(decoding: received[0], as: UTF8.self) == #"{"type":"ping"}"#)
  }

  @Test("1 接続で複数行を順序通りに受信する")
  func receivesMultipleLines() async throws {
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    try await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    let payload = Data(
      """
      {"i":1}
      {"i":2}
      {"i":3}

      """.utf8)
    sendOverUnixSocket(path: path, data: payload)

    try await waitUntil(timeout: .seconds(2)) { messages.snapshot().count == 3 }
    let received = messages.snapshot().map { String(decoding: $0, as: UTF8.self) }
    #expect(received == [#"{"i":1}"#, #"{"i":2}"#, #"{"i":3}"#])
  }

  @Test("複数接続から並行受信できる")
  func receivesFromMultipleConnections() async throws {
    let path = makeSocketPath()
    defer { unlink(path) }

    let messages = MessageCollector()
    let server = SocketServer(socketPath: path)
    try server.start { data in messages.append(data) }
    defer { server.stop() }

    try await waitUntil(timeout: .seconds(2)) { fileExists(path) }

    await withTaskGroup(of: Void.self) { group in
      for i in 0..<5 {
        group.addTask {
          sendOverUnixSocket(path: path, data: Data(#"{"i":\#(i)}\#n"#.utf8))
        }
      }
    }

    try await waitUntil(timeout: .seconds(3)) { messages.snapshot().count == 5 }
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

private func waitUntil(
  timeout: Duration,
  _ condition: @escaping @Sendable () -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if condition() { return }
    try await Task.sleep(for: .milliseconds(30))
  }
}

/// NWConnection ベースの Unix Socket クライアント。同期版（テスト用）。
/// 本番 CLI 側は POSIX socket + shutdown(SHUT_WR) drain パターンで実装する予定だが、
/// Server のテストとしてはどちらのクライアントでも同じ。
private func sendOverUnixSocket(path: String, data: Data) {
  let queue = DispatchQueue(label: "gozd.test.client")
  let params = NWParameters()
  params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
  let conn = NWConnection(to: .unix(path: path), using: params)

  let ready = DispatchSemaphore(value: 0)
  conn.stateUpdateHandler = { state in
    switch state {
    case .ready, .failed, .cancelled:
      ready.signal()
    default:
      break
    }
  }
  conn.start(queue: queue)
  _ = ready.wait(timeout: .now() + 2.0)

  let sent = DispatchSemaphore(value: 0)
  conn.send(
    content: data,
    completion: .contentProcessed { _ in sent.signal() }
  )
  _ = sent.wait(timeout: .now() + 2.0)

  conn.cancel()
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
