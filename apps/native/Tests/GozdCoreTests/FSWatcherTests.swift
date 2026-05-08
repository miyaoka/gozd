import Foundation
import Testing

@testable import GozdCore

@Suite("FSWatcher")
struct FSWatcherTests {
  @Test("ファイル作成を検知する")
  func detectsFileCreation() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventCollector()
    let watcher = FSWatcher(paths: [tmpDir.path], latency: 0.05)
    watcher.setHandler { events in
      collector.append(events)
    }

    try watcher.start()
    defer { watcher.stop() }

    // FSEvents が ready になるまで僅かに待つ。
    try await Task.sleep(for: .milliseconds(300))

    let testFile = tmpDir.appendingPathComponent("hello.txt")
    try "hello".write(to: testFile, atomically: true, encoding: .utf8)

    // 0.05s latency + small margin
    try await waitForEvent(collector, matching: { $0.path.hasSuffix("hello.txt") })

    let events = collector.snapshot()
    #expect(events.contains { $0.path.hasSuffix("hello.txt") })
  }

  @Test("ファイル削除を検知する")
  func detectsFileRemoval() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let testFile = tmpDir.appendingPathComponent("doomed.txt")
    try "bye".write(to: testFile, atomically: true, encoding: .utf8)

    let collector = EventCollector()
    let watcher = FSWatcher(paths: [tmpDir.path], latency: 0.05)
    watcher.setHandler { events in
      collector.append(events)
    }

    try watcher.start()
    defer { watcher.stop() }

    try await Task.sleep(for: .milliseconds(300))

    try FileManager.default.removeItem(at: testFile)

    try await waitForEvent(collector, matching: { $0.path.hasSuffix("doomed.txt") })

    let events = collector.snapshot()
    #expect(events.contains { $0.path.hasSuffix("doomed.txt") })
  }

  @Test("サブディレクトリ内のファイル変更を検知する")
  func detectsRecursiveChange() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let subDir = tmpDir.appendingPathComponent("sub")
    try FileManager.default.createDirectory(at: subDir, withIntermediateDirectories: true)

    let collector = EventCollector()
    let watcher = FSWatcher(paths: [tmpDir.path], latency: 0.05)
    watcher.setHandler { events in
      collector.append(events)
    }

    try watcher.start()
    defer { watcher.stop() }

    try await Task.sleep(for: .milliseconds(300))

    let nestedFile = subDir.appendingPathComponent("nested.txt")
    try "nested".write(to: nestedFile, atomically: true, encoding: .utf8)

    try await waitForEvent(collector, matching: { $0.path.hasSuffix("nested.txt") })

    let events = collector.snapshot()
    #expect(events.contains { $0.path.hasSuffix("nested.txt") })
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  // /private prefix を解決した実パスにする（FSEvents は realpath を返すため
  // /var/folders/... が /private/var/folders/... に変換されたパスで通知される）
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fswatcher-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  let resolved = URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
  return resolved
}

private func waitForEvent(
  _ collector: EventCollector,
  timeout: Duration = .seconds(2),
  matching predicate: @escaping (FSWatcher.Event) -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if collector.snapshot().contains(where: predicate) { return }
    try await Task.sleep(for: .milliseconds(50))
  }
}

// 並行アクセス可能な event collector。Swift 6.2 のデフォルト strict concurrency
// 下で使うため @unchecked Sendable + lock。
private final class EventCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [FSWatcher.Event] = []

  func append(_ newEvents: [FSWatcher.Event]) {
    lock.lock()
    defer { lock.unlock() }
    events.append(contentsOf: newEvents)
  }

  func snapshot() -> [FSWatcher.Event] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }
}
