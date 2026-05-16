import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("ClaudeSessionStore")
struct ClaudeSessionStoreTests {
  @Test("upsert → savedSessions で同一 worktree のエントリだけ返る")
  func upsertAndList() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let wt1 = env.worktreeA
    let wt2 = env.worktreeB

    try await store.upsert(worktreePath: wt1, sessionId: "s1")
    try await store.upsert(worktreePath: wt2, sessionId: "s2")
    try await store.upsert(worktreePath: wt1, sessionId: "s3")

    let saved1 = try await store.savedSessions(for: wt1)
    let saved2 = try await store.savedSessions(for: wt2)
    #expect(Set(saved1.map { $0.sessionID }) == Set(["s1", "s3"]))
    #expect(saved2.map { $0.sessionID } == ["s2"])
  }

  @Test("同じ sessionId の upsert は重複ではなく置換になる")
  func upsertDedup() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "same")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "same")

    let saved = try await store.savedSessions(for: env.worktreeA)
    #expect(saved.count == 1)
  }

  @Test("removeBySessionId は該当 ID のみ削除する")
  func removeBySessionId() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "keep")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "drop")

    try await store.removeBySessionId(worktreePath: env.worktreeA, sessionId: "drop")

    let saved = try await store.savedSessions(for: env.worktreeA)
    #expect(saved.map { $0.sessionID } == ["keep"])
  }

  @Test("allSavedSessions は worktree 横断で保存セッションを返す")
  func allSavedSessionsAcrossWorktrees() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "a")
    try await store.upsert(worktreePath: env.worktreeB, sessionId: "b")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "c")

    // どの dir を anchor にしても projectKey は同じ（同 main repo の worktree なので）
    let all = try await store.allSavedSessions(forProject: env.worktreeA)
    #expect(Set(all.map { $0.sessionID }) == Set(["a", "b", "c"]))
  }

  @Test("removeByWorktreePath は projectAnchorDir で projectKey を解決し対象 worktree のエントリだけ削除する")
  func removeByWorktreePathUsesAnchor() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "a")
    try await store.upsert(worktreePath: env.worktreeB, sessionId: "b")

    // worktreeA を物理削除しても、anchor として mainRepo（残っている dir）を渡せば cleanup できる
    try FileManager.default.removeItem(atPath: env.worktreeA)
    try await store.removeByWorktreePath(
      projectAnchorDir: env.mainRepo, worktreePath: env.worktreeA)

    let savedB = try await store.savedSessions(for: env.worktreeB)
    #expect(savedB.map { $0.sessionID } == ["b"])
    let allRemaining = try await store.allSavedSessions(forProject: env.mainRepo)
    #expect(allRemaining.map { $0.sessionID } == ["b"])
  }
}

// MARK: - test helpers

private struct ClaudeSessionTestEnv {
  let configDir: String
  let mainRepo: String
  let worktreeA: String
  let worktreeB: String
}

private func makeEnv() throws -> ClaudeSessionTestEnv {
  let base = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-claude-store-\(UUID().uuidString.prefix(8))")
  let mainRepo = base.appendingPathComponent("main").path
  let worktreeA = base.appendingPathComponent("wt-a").path
  let worktreeB = base.appendingPathComponent("wt-b").path
  let configDir = base.appendingPathComponent("config").path

  let fm = FileManager.default
  for path in [mainRepo, configDir] {
    try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
  }

  // 3 つの dir を同じ projectKey に解決させるため、git init + 初期 commit + worktree add
  // で実際の git worktree 構造を作る。`ProjectKey.resolveAndCompute` は git の
  // common-dir を main repo root に解決する。
  try runGitSync(args: ["init", "-q", "-b", "main"], cwd: mainRepo)
  try runGitSync(args: ["config", "user.email", "test@example.com"], cwd: mainRepo)
  try runGitSync(args: ["config", "user.name", "Test"], cwd: mainRepo)
  try runGitSync(args: ["commit", "-q", "--allow-empty", "-m", "init"], cwd: mainRepo)
  try runGitSync(args: ["worktree", "add", "-q", "-B", "wt-a", worktreeA], cwd: mainRepo)
  try runGitSync(args: ["worktree", "add", "-q", "-B", "wt-b", worktreeB], cwd: mainRepo)

  return ClaudeSessionTestEnv(
    configDir: configDir,
    mainRepo: mainRepo,
    worktreeA: worktreeA,
    worktreeB: worktreeB
  )
}

private func runGitSync(args: [String], cwd: String) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = ["git"] + args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = ProcessInfo.processInfo.environment
  process.standardOutput = Pipe()
  process.standardError = Pipe()
  try process.run()
  process.waitUntilExit()
}

private func cleanup(_ env: ClaudeSessionTestEnv) {
  let base = (env.configDir as NSString).deletingLastPathComponent
  try? FileManager.default.removeItem(atPath: base)
}
