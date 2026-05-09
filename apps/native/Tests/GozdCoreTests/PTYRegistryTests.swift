import Foundation
import Testing

@testable import GozdCore

@Suite("PTYRegistry")
struct PTYRegistryTests {
  @Test("spawn は連番の ptyId を返し、onText / onExit が ID 付きで配送される")
  func spawnAndExitDispatch() async throws {
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    let id1 = try await registry.spawn(
      executable: "/bin/echo",
      args: ["echo", "hello"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80
    )
    let id2 = try await registry.spawn(
      executable: "/bin/echo",
      args: ["echo", "world"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80
    )
    #expect(id2 == id1 + 1)

    try await waitUntil(timeout: .seconds(3)) {
      events.exitedIds().contains(id1) && events.exitedIds().contains(id2)
    }

    #expect(events.textFor(id: id1).contains("hello"))
    #expect(events.textFor(id: id2).contains("world"))
  }

  @Test("kill 後に PTY が registry から自動削除される")
  func cleanupOnKill() async throws {
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    let id = try await registry.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80
    )
    #expect(await registry.count() == 1)

    try await Task.sleep(for: .milliseconds(100))
    await registry.kill(id: id)

    try await waitUntil(timeout: .seconds(2)) {
      events.exitedIds().contains(id)
    }
    // remove は exit handler 経由で `Task { await self.remove }` で発火するため、
    // actor の serial execution に届くまで小さくポーリングする。
    let deadline = ContinuousClock.now.advanced(by: .seconds(1))
    while ContinuousClock.now < deadline {
      if await registry.count() == 0 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(await registry.count() == 0)
  }

  @Test("未知の ptyId への write / resize / kill は no-op")
  func unknownIdIsNoop() async throws {
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    await registry.write(id: 9999, data: Data("ping\n".utf8))
    await registry.resize(id: 9999, rows: 50, cols: 100)
    await registry.kill(id: 9999)
    // ここまで例外なく到達すれば OK
    #expect(await registry.count() == 0)
  }
}

// MARK: - Helpers

private func waitUntil(
  timeout: Duration,
  _ condition: @escaping @Sendable () -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if condition() { return }
    try await Task.sleep(for: .milliseconds(50))
  }
}

private final class EventCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var textMap: [UInt32: String] = [:]
  private var exits: [UInt32: PTYExitReason] = [:]

  func appendText(id: UInt32, text: String) {
    lock.lock()
    defer { lock.unlock() }
    textMap[id, default: ""].append(text)
  }

  func appendExit(id: UInt32, reason: PTYExitReason) {
    lock.lock()
    defer { lock.unlock() }
    exits[id] = reason
  }

  func textFor(id: UInt32) -> String {
    lock.lock()
    defer { lock.unlock() }
    return textMap[id] ?? ""
  }

  func exitedIds() -> Set<UInt32> {
    lock.lock()
    defer { lock.unlock() }
    return Set(exits.keys)
  }
}
