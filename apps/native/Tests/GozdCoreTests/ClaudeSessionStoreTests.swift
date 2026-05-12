import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("ClaudeSessionStore")
struct ClaudeSessionStoreTests {
  @Test("upsert → liveSessions で同一 worktree のエントリだけ返る")
  func upsertAndList() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let wt1 = env.worktreeA
    let wt2 = env.worktreeB
    let session1 = makeTranscript(in: env.transcriptDir, sessionId: "s1")
    let session2 = makeTranscript(in: env.transcriptDir, sessionId: "s2")
    let session3 = makeTranscript(in: env.transcriptDir, sessionId: "s3")

    try await store.upsert(worktreePath: wt1, sessionId: "s1", transcriptPath: session1)
    try await store.upsert(worktreePath: wt2, sessionId: "s2", transcriptPath: session2)
    try await store.upsert(worktreePath: wt1, sessionId: "s3", transcriptPath: session3)

    let live1 = try await store.liveSessions(for: wt1)
    let live2 = try await store.liveSessions(for: wt2)
    #expect(Set(live1.map { $0.sessionID }) == Set(["s1", "s3"]))
    #expect(live2.map { $0.sessionID } == ["s2"])
  }

  @Test("同じ sessionId の upsert は重複ではなく置換になる")
  func upsertDedup() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let transcript = makeTranscript(in: env.transcriptDir, sessionId: "same")
    try await store.upsert(
      worktreePath: env.worktreeA, sessionId: "same", transcriptPath: transcript)
    try await store.upsert(
      worktreePath: env.worktreeA, sessionId: "same", transcriptPath: transcript)

    let live = try await store.liveSessions(for: env.worktreeA)
    #expect(live.count == 1)
  }

  @Test("removeBySessionId は該当 ID のみ削除する")
  func removeBySessionId() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let t1 = makeTranscript(in: env.transcriptDir, sessionId: "keep")
    let t2 = makeTranscript(in: env.transcriptDir, sessionId: "drop")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "keep", transcriptPath: t1)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "drop", transcriptPath: t2)

    try await store.removeBySessionId(worktreePath: env.worktreeA, sessionId: "drop")

    let live = try await store.liveSessions(for: env.worktreeA)
    #expect(live.map { $0.sessionID } == ["keep"])
  }

  @Test("liveSessions は transcript ファイル不在エントリを結果から除外するが永続化は変更しない")
  func liveSessionsPureRead() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let t1 = makeTranscript(in: env.transcriptDir, sessionId: "alive")
    let t2 = makeTranscript(in: env.transcriptDir, sessionId: "dead")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "alive", transcriptPath: t1)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "dead", transcriptPath: t2)

    try FileManager.default.removeItem(atPath: t2)

    // 結果からは dead が除外される
    let live = try await store.liveSessions(for: env.worktreeA)
    #expect(live.map { $0.sessionID } == ["alive"])

    // pure read なのでファイルは触らない。removeBySessionId で alive を消すと、
    // 永続化に残っている dead エントリも見えるはず（dead もまだ json に残っている）
    try await store.removeBySessionId(worktreePath: env.worktreeA, sessionId: "alive")
    // 再度 transcript を作って dead を生き返らせる
    FileManager.default.createFile(atPath: t2, contents: Data("{}\n".utf8))
    let revived = try await store.liveSessions(for: env.worktreeA)
    #expect(revived.map { $0.sessionID } == ["dead"])
  }

  @Test("reconcileAll は transcript 不在エントリを永続化から削除する")
  func reconcileAllDropsDeadEntries() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let t1 = makeTranscript(in: env.transcriptDir, sessionId: "alive")
    let t2 = makeTranscript(in: env.transcriptDir, sessionId: "dead")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "alive", transcriptPath: t1)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "dead", transcriptPath: t2)

    try FileManager.default.removeItem(atPath: t2)
    try await store.reconcileAll()

    // reconcileAll で永続化から落とされたので、dead の transcript を復活させても resume されない
    FileManager.default.createFile(atPath: t2, contents: Data("{}\n".utf8))
    let live = try await store.liveSessions(for: env.worktreeA)
    #expect(live.map { $0.sessionID } == ["alive"])
  }

  @Test("allLiveSessions は worktree 横断で生存セッションを返す")
  func allLiveSessionsAcrossWorktrees() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let t1 = makeTranscript(in: env.transcriptDir, sessionId: "a")
    let t2 = makeTranscript(in: env.transcriptDir, sessionId: "b")
    let t3 = makeTranscript(in: env.transcriptDir, sessionId: "c")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "a", transcriptPath: t1)
    try await store.upsert(worktreePath: env.worktreeB, sessionId: "b", transcriptPath: t2)
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "c", transcriptPath: t3)

    // どの dir を anchor にしても projectKey は同じ（同 main repo の worktree なので）
    let all = try await store.allLiveSessions(forProject: env.worktreeA)
    #expect(Set(all.map { $0.sessionID }) == Set(["a", "b", "c"]))
  }

  @Test("removeByWorktreePath は projectAnchorDir で projectKey を解決し対象 worktree のエントリだけ削除する")
  func removeByWorktreePathUsesAnchor() async throws {
    let env = try makeEnv()
    defer { cleanup(env) }

    let store = ClaudeSessionStore(configDir: env.configDir)
    let t1 = makeTranscript(in: env.transcriptDir, sessionId: "a")
    let t2 = makeTranscript(in: env.transcriptDir, sessionId: "b")
    try await store.upsert(worktreePath: env.worktreeA, sessionId: "a", transcriptPath: t1)
    try await store.upsert(worktreePath: env.worktreeB, sessionId: "b", transcriptPath: t2)

    // worktreeA を物理削除しても、anchor として mainRepo（残っている dir）を渡せば cleanup できる
    try FileManager.default.removeItem(atPath: env.worktreeA)
    try await store.removeByWorktreePath(
      projectAnchorDir: env.mainRepo, worktreePath: env.worktreeA)

    let liveB = try await store.liveSessions(for: env.worktreeB)
    #expect(liveB.map { $0.sessionID } == ["b"])
    // worktreeA に対する liveSessions は dir が消えていても 0 を返す（残骸はファイルから消えている）
    let allRemaining = try await store.allLiveSessions(forProject: env.mainRepo)
    #expect(allRemaining.map { $0.sessionID } == ["b"])
  }
}

// MARK: - test helpers

private struct ClaudeSessionTestEnv {
  let configDir: String
  let mainRepo: String
  let worktreeA: String
  let worktreeB: String
  let transcriptDir: String
}

private func makeEnv() throws -> ClaudeSessionTestEnv {
  let base = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-claude-store-\(UUID().uuidString.prefix(8))")
  let mainRepo = base.appendingPathComponent("main").path
  let worktreeA = base.appendingPathComponent("wt-a").path
  let worktreeB = base.appendingPathComponent("wt-b").path
  let configDir = base.appendingPathComponent("config").path
  let transcriptDir = base.appendingPathComponent("transcripts").path

  let fm = FileManager.default
  for path in [mainRepo, configDir, transcriptDir] {
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
    worktreeB: worktreeB,
    transcriptDir: transcriptDir
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

private func makeTranscript(in dir: String, sessionId: String) -> String {
  let path = (dir as NSString).appendingPathComponent("\(sessionId).jsonl")
  FileManager.default.createFile(atPath: path, contents: Data("{}\n".utf8))
  return path
}
