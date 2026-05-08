import Foundation
import Testing

@testable import GozdCore

@Suite("PTYManager")
struct PTYManagerTests {
  @Test("子プロセスの stdout を受け取り、正常終了 (.exited(0)) を検知する")
  func receivesOutputAndExit() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/echo",
      args: ["echo", "hello"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // pty (tty mode) は ONLCR で \n を \r\n に変換する。
    let text = String(decoding: data.snapshot(), as: UTF8.self)
    #expect(text.contains("hello"))
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("write した内容を子プロセス経由で読み戻せる（cat エコー）")
  func writeRoundTrip() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    // tty が ready になるのを待つ。
    try await Task.sleep(for: .milliseconds(150))

    pty.write(Data("ping\n".utf8))

    try await waitUntil(timeout: .seconds(2)) {
      String(decoding: data.snapshot(), as: UTF8.self).contains("ping")
    }

    pty.kill()
    try await waitUntil(timeout: .seconds(2)) { exit.snapshot() != nil }

    if case .signaled(let sig, _) = exit.snapshot() {
      #expect(sig == SIGHUP)
    } else {
      Issue.record("expected SIGHUP signaled exit, got \(String(describing: exit.snapshot()))")
    }
  }

  @Test("resize は fd 確立前後で crash しない")
  func resizeIsSafe() async throws {
    let pty = PTYManager()
    pty.resize(rows: 30, cols: 100)  // fd 未確立: no-op
    let data = DataCollector()
    let exit = ExitCollector()
    try pty.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )
    pty.resize(rows: 40, cols: 120)
    pty.kill()
    try await waitUntil(timeout: .seconds(2)) { exit.snapshot() != nil }
    #expect(exit.snapshot() != nil)
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

private final class DataCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()

  func append(_ chunk: Data) {
    lock.lock()
    defer { lock.unlock() }
    data.append(chunk)
  }

  func snapshot() -> Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

private final class ExitCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var reason: PTYExitReason?

  func set(_ value: PTYExitReason) {
    lock.lock()
    defer { lock.unlock() }
    reason = value
  }

  func snapshot() -> PTYExitReason? {
    lock.lock()
    defer { lock.unlock() }
    return reason
  }
}
