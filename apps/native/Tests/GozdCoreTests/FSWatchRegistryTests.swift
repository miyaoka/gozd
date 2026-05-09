import Foundation
import Testing

@testable import GozdCore

@Suite("FSWatchRegistry")
struct FSWatchRegistryTests {
  @Test("watch した dir 配下のファイル作成で fsChange handler が呼ばれる")
  func dispatchesFsChangeOnWorkTreeFile() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { dir, _ in collector.append("fsChange:\(dir)") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    let file = tmpDir.appendingPathComponent("hello.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)

    try await waitForEvent(
      collector, matching: { $0.hasPrefix("fsChange:") })
    let events = collector.snapshot()
    #expect(events.contains { $0.hasPrefix("fsChange:") })
  }

  @Test("`.git/refs/heads/...` 変更で branchChange が分類される")
  func classifiesBranchChange() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let refsHeads = tmpDir.appendingPathComponent(".git/refs/heads")
    try FileManager.default.createDirectory(
      at: refsHeads, withIntermediateDirectories: true)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    let branchFile = refsHeads.appendingPathComponent("feature-x")
    try "0123456789abcdef".write(to: branchFile, atomically: true, encoding: .utf8)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
  }

  @Test("unwatch 後はイベントが届かない")
  func unwatchStopsDispatch() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    // unwatch を actor 上で処理させた後に collector を clear する。
    // unwatch 前に clear すると、watch 開始直後の latent event が clear と unwatch の
    // 間に配送される余地が残るため、テストの主旨（「unwatch 以降の変更で dispatch が
    // 走らない」）から外れた失敗が起きうる。
    await registry.unwatch(dir: tmpDir.path)
    collector.clear()

    let file = tmpDir.appendingPathComponent("after-unwatch.txt")
    try "x".write(to: file, atomically: true, encoding: .utf8)

    try await Task.sleep(for: .milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fswatchregistry-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
}

private func waitForEvent(
  _ collector: EventNameCollector,
  timeout: Duration = .seconds(2),
  matching predicate: @escaping (String) -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if collector.snapshot().contains(where: predicate) { return }
    try await Task.sleep(for: .milliseconds(50))
  }
}

private final class EventNameCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []

  func append(_ name: String) {
    lock.lock()
    defer { lock.unlock() }
    events.append(name)
  }

  func snapshot() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    events.removeAll()
  }
}
