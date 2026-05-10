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

  @Test("git repo の `.git/refs/heads/...` 変更で branchChange が分類される")
  func classifiesBranchChange() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    let branchFile = tmpDir.appendingPathComponent(".git/refs/heads/feature-x")
    try "0123456789abcdef0123456789abcdef01234567\n"
      .write(to: branchFile, atomically: true, encoding: .utf8)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
  }

  @Test("worktree 内 commit で gitStatusChange が分類される（実体は親 repo の .git/worktrees/）")
  func classifiesGitStatusChangeForWorktreeCommit() async throws {
    let mainRepo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: mainRepo) }
    try await initGitRepo(at: mainRepo)

    // 初回 commit を作って HEAD を確立する。
    let seed = mainRepo.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: mainRepo)
    try await runGitCmd(["commit", "-m", "seed"], cwd: mainRepo)

    // worktree を分岐させる。
    let worktreeRoot = mainRepo.deletingLastPathComponent()
      .appendingPathComponent("wt-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: worktreeRoot) }
    try await runGitCmd(
      ["worktree", "add", "-b", "feature", worktreeRoot.path], cwd: mainRepo)
    let worktreeRootResolved = URL(fileURLWithPath: worktreeRoot.path).resolvingSymlinksInPath()

    // watch 開始前にファイル作成と add まで済ませる。watch 中の handleEvents は
    // `gitStatusFull` を spawn し、`git status` は read-only だが index stat refresh で
    // 同じ per-worktree git dir の `index.lock` を取りにいく場合がある。そこに `git add`
    // / `git commit` をぶつけると lock 競合で test が flake する。watch 中に撃つ git ops
    // は単一の `git commit` だけに絞り、gitStatusChange の発火経路を確実に踏ませる。
    let file = worktreeRootResolved.appendingPathComponent("a.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "a.txt"], cwd: worktreeRootResolved)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: worktreeRootResolved.path)
    try await Task.sleep(for: .milliseconds(300))
    collector.clear()

    try await runGitCmd(["commit", "-m", "add a"], cwd: worktreeRootResolved)

    try await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("gitStatusChange"))
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

// MARK: - classify pure unit tests

@Suite("FSWatchRegistry.classify")
struct ClassifyTests {
  // 共通の Event 生成 helper。flags / id は分類に影響しないので 0 固定。
  private func ev(_ path: String) -> FSWatcher.Event {
    FSWatcher.Event(path: path, flags: 0, id: 0)
  }

  @Test("worktree 配置: per-worktree git dir 配下の HEAD は gitStatusChange のみ")
  func worktreePerWorktreeHead() {
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(perWt)/HEAD")])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の refs/heads/main は branchChange")
  func worktreeCommonBranchRef() {
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(common)/refs/heads/main")])
    #expect(result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の packed-refs は branchChange + gitStatusChange")
  func worktreeCommonPackedRefs() {
    // packed-refs は local ref と remote-tracking ref のどちらの pack かファイル名から
    // 判別不能なので両 subscriber に通知する。
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(common)/packed-refs")])
    #expect(result.hasBranchChange)
    #expect(result.hasGitStatusChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の refs/remotes/origin/main は gitStatusChange")
  func worktreeCommonRemoteRef() {
    // git push / fetch 成功でローカルの remote-tracking ref が書き換わる。
    // git-graph の ahead/behind を更新するための gitStatusChange 経路。
    // worktree 一覧構造は変わらないため branchChange は発火させない。
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(common)/refs/remotes/origin/main")])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: 兄弟 worktree の worktrees/<other> 追加は worktreeChange")
  func worktreeCommonSiblingAdded() {
    // 自分の per-wt git dir は foo。兄弟 bar が追加されると `<common>/worktrees/bar/...` に
    // ファイルが生まれる。これは worktree list の変更なので worktreeChange を発火させる。
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(common)/worktrees/bar/HEAD")])
    #expect(result.hasWorktreeChange)
    #expect(!result.hasGitStatusChange)
  }

  @Test("worktree 配置: 自身の per-wt 内部 (例: locked) は worktreeChange を発火させない")
  func worktreeCommonSelfInternalNotWorktreeChange() {
    // `<common>/worktrees/foo/locked` は per-wt git dir 配下なので per-wt 規則のみ適用。
    // worktree list の変更ではないため worktreeChange は出ない。
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(perWt)/locked")])
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasGitStatusChange)  // locked は HEAD/index ではないので status も無し
  }

  @Test("worktree 配置: 作業ツリー配下のファイルは fsChange + gitStatusChange")
  func worktreeWorkTreeFile() {
    let dir = "/wt/foo"
    let perWt = "/parent/.git/worktrees/foo"
    let common = "/parent/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev("\(dir)/src/a.ts")])
    #expect(result.hasFsChange)
    #expect(result.hasGitStatusChange)
    #expect(result.fsRelDirs == ["src"])
  }

  @Test("通常 clone: per-worktree == common == <dir>/.git でも HEAD と refs/heads が両方分類される")
  func normalCloneDualClassification() {
    let dir = "/repo"
    let gitDir = "\(dir)/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [
        ev("\(gitDir)/HEAD"),
        ev("\(gitDir)/refs/heads/main"),
      ])
    #expect(result.hasGitStatusChange)
    #expect(result.hasBranchChange)
    // 通常 clone でも .git 配下は作業ツリー判定に乗せない
    #expect(!result.hasFsChange)
  }

  @Test("通常 clone: .git 配下の関心外ファイル（objects/）は何も発火させない")
  func normalCloneIgnoresObjects() {
    let dir = "/repo"
    let gitDir = "\(dir)/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev("\(gitDir)/objects/ab/cdef")])
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("git dir nil（非 repo）: 作業ツリー配下のファイルは fsChange + gitStatusChange")
  func nonRepoFallsToWorkTreeBranch() {
    let dir = "/somewhere"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: nil, commonGitDir: nil,
      events: [ev("\(dir)/note.txt")])
    #expect(result.hasFsChange)
    #expect(result.hasGitStatusChange)
  }

  @Test("dir 配下でも git dir 配下でもない event は無視")
  func unrelatedPathIgnored() {
    let dir = "/repo"
    let gitDir = "\(dir)/.git"
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev("/elsewhere/x.txt")])
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fswatchregistry-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
}

private struct GitCmdError: Error, CustomStringConvertible {
  let args: [String]
  let exitCode: Int32
  let stderr: String
  var description: String {
    "git \(args.joined(separator: " ")) failed (exit \(exitCode)): \(stderr)"
  }
}

private func runGitCmd(_ args: [String], cwd: URL) async throws {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  p.arguments = ["git"] + args
  p.currentDirectoryURL = cwd
  // テスト用 commit のために identity を上書きする。
  var env = ProcessInfo.processInfo.environment
  env["GIT_AUTHOR_NAME"] = "test"
  env["GIT_AUTHOR_EMAIL"] = "test@example.com"
  env["GIT_COMMITTER_NAME"] = "test"
  env["GIT_COMMITTER_EMAIL"] = "test@example.com"
  p.environment = env
  let stderrPipe = Pipe()
  p.standardOutput = Pipe()
  p.standardError = stderrPipe
  try p.run()
  p.waitUntilExit()
  if p.terminationStatus != 0 {
    let stderr = String(
      decoding: stderrPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    throw GitCmdError(args: args, exitCode: p.terminationStatus, stderr: stderr)
  }
}

private func initGitRepo(at dir: URL) async throws {
  try await runGitCmd(["init", "-q", "-b", "main"], cwd: dir)
}

private struct EventTimeout: Error, CustomStringConvertible {
  let timeout: Duration
  let observed: [String]
  var description: String {
    "waitForEvent timed out after \(timeout). Observed events: \(observed)"
  }
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
  // タイムアウトを silent return せず throw する。「期待イベントが届かなかった」のか
  // 「タイムアウトで打ち切った」のかを呼び出し側が区別できるようにする。
  throw EventTimeout(timeout: timeout, observed: collector.snapshot())
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
