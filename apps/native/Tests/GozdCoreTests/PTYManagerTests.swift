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

  @Test("0 byte 出力で正常終了する child (/usr/bin/true) でも onExit が発火する")
  func zeroByteOutput() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/usr/bin/true",
      args: ["true"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // /usr/bin/true は何も出力せず exit 0 で終わる。
    // tty mode で promptless なので、データは 0 byte または echo 由来の数 byte のみ。
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("stderr のみに書く child の出力も master fd から読める")
  func stderrIsCapturedThroughSlave() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/sh",
      args: ["sh", "-c", "echo stderr-marker >&2"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // login_tty で slave fd は stdin/stdout/stderr すべてに dup2 されているため
    // stderr 出力も master 経由で観測できる。
    let text = String(decoding: data.snapshot(), as: UTF8.self)
    #expect(text.contains("stderr-marker"))
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("存在しない cwd を指定すると exited(code: 124) を返す (chdir 失敗)")
  func chdirFailureReportedAsExit124() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/usr/bin/true",
      args: ["true"],
      env: ProcessInfo.processInfo.environment,
      // 一意に存在しないパス。CPty.c の chdir() != 0 経路で _exit(124)。
      cwd: "/nonexistent-gozd-chdir-test-target-zzzz",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }
    #expect(exit.snapshot() == .exited(code: 124))
  }

  @Test("ディレクトリを executable に指定すると exited(code: 126) を返す (execve EACCES)")
  func execveEACCESReportedAsExit126() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    // /tmp はディレクトリで execute bit は付くが execve は EACCES を返す
    // （macOS execve(2): 「The new process file is not a regular file」も含めて EACCES）。
    try pty.spawn(
      executable: "/tmp",
      args: ["tmp"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }
    #expect(exit.snapshot() == .exited(code: 126))
  }

  @Test("実行できないパス (/path/does/not/exist) は exited(code: 127) を返す")
  func execveENOENTReportedAsExit127() async throws {
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/path/does/not/exist",
      args: ["nonexistent"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // POSIX shell 慣例 / CPty.c の child で execve ENOENT → _exit(127)。
    #expect(exit.snapshot() == .exited(code: 127))
  }
}

// MARK: - Helpers

/// `condition()` が true を返すまで小さくポーリングで待つ。timeout 到達時に
/// `Issue.record` で test を fail させる。silent return すると後段の `#expect` が
/// 別の症状（exit が nil など）で間接 fail し、timeout だった事象を追跡できなくなる。
private func waitUntil(
  timeout: Duration,
  description: String = "condition",
  _ condition: @escaping @Sendable () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if condition() { return }
    try await Task.sleep(for: .milliseconds(50))
  }
  Issue.record(
    "waitUntil timed out after \(timeout) waiting for: \(description)",
    sourceLocation: sourceLocation)
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
