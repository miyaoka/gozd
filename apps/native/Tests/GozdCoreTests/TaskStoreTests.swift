import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("TaskStore")
struct TaskStoreTests {
  // MARK: - attachSession

  @Test("attachSession: 既に同 sessionID の task があれば no-op (重複 hook / 復元レース)")
  func attachSessionIdempotent() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let task = try await store.add(
      dir: env.worktreeA, body: "existing", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "s1", worktreeDir: env.worktreeA)

    // 再度同じ sessionId で attach しても no-op
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "s1", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let attached = list.filter { $0.sessionID == "s1" }
    #expect(attached.count == 1)
    #expect(attached.first?.id == task.id)
  }

  @Test("attachSession: sessionId 空の最新 task に attach (createdAt 降順)")
  func attachSessionPicksLatestEmpty() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // createdAt をテストフックで明示注入し、時間ベース待機を避ける。
    let older = try await store.add(
      dir: env.worktreeA, body: "older", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0,
      createdAt: "2026-05-15T00:00:00Z"
    )
    let newer = try await store.add(
      dir: env.worktreeA, body: "newer", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0,
      createdAt: "2026-05-16T00:00:00Z"
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let olderResult = list.first { $0.id == older.id }
    let newerResult = list.first { $0.id == newer.id }
    #expect(olderResult?.sessionID == "")
    #expect(newerResult?.sessionID == "fresh")
  }

  @Test("attachSession: 該当 task 無しなら新規 task を作成 (Claude 直接起動経路)")
  func attachSessionCreatesNew() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "lone", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    let task = try #require(list.first)
    #expect(task.sessionID == "lone")
    #expect(task.body == "")
    #expect(task.worktreeDir == env.worktreeA)
    // id は UUID で生成される (sessionId と独立)
    #expect(task.id != "lone")
    #expect(!task.id.isEmpty)
  }

  @Test("attachSession: 他 worktree の sessionId 空 task は attach 対象外")
  func attachSessionScopedByWorktreeDir() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let foreign = try await store.add(
      dir: env.worktreeA, body: "for-b", worktreeDir: env.worktreeB,
      prNumber: 0, issueNumber: 0
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "for-a", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    // wtB 向けの task は attach されず、wtA 向けに新規 task が追加されている
    let foreignResult = list.first { $0.id == foreign.id }
    #expect(foreignResult?.sessionID == "")
    let attachedToA = list.first { $0.worktreeDir == env.worktreeA && $0.sessionID == "for-a" }
    #expect(attachedToA != nil)
  }

  // MARK: - detachSession

  @Test("detachSession: body / pr / issue がすべて空なら task 削除 (Claude 直接起動 + 即終了の残骸)")
  func detachSessionRemovesEmpty() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "empty", worktreeDir: env.worktreeA)
    #expect(try await store.list(dir: env.worktreeA).count == 1)

    try await store.detachSession(dir: env.worktreeA, sessionId: "empty")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.isEmpty)
  }

  @Test("detachSession: body があれば task は残し sessionID は保持 (再 resume の起点)")
  func detachSessionKeepsIdentified() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let task = try await store.add(
      dir: env.worktreeA, body: "Refactor X", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "live")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    let kept = try #require(list.first)
    #expect(kept.id == task.id)
    #expect(kept.body == "Refactor X")
    #expect(kept.sessionID == "live") // 再 resume 用に保持
  }

  @Test("detachSession: prNumber > 0 でも task を残す (PR/issue 由来 task の永続性)")
  func detachSessionKeepsPrTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "", worktreeDir: env.worktreeA,
      prNumber: 42, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "pr-sid", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "pr-sid")

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.prNumber == 42)
    #expect(kept.sessionID == "pr-sid")
  }

  @Test("detachSession: sessionId 不一致なら no-op (silent return)")
  func detachSessionUnknownId() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "nonexistent")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.sessionID == "live")
  }

  // MARK: - reconcileAll

  @Test("reconcileAll: dead sessionID は task からクリアして本体は維持する")
  func reconcileClearsDeadSession() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "identified", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead", worktreeDir: env.worktreeA)
    // 当該 projectKey の claude-sessions.json は作らない (= dead 扱い)

    let failed = try await store.reconcileAll()
    #expect(failed.isEmpty)

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.body == "identified")
    #expect(kept.sessionID == "") // dead セッション ID はクリア
  }

  @Test("reconcileAll: identity 完全消失 (body / pr / issue / sessionId すべて空) の task は孤児削除")
  func reconcileDropsOrphans() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // body 空 + identity 無し + dead session 付きの task のみ存在させる
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "ghost", worktreeDir: env.worktreeA)

    let failed = try await store.reconcileAll()
    #expect(failed.isEmpty)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.isEmpty) // dead session クリア → identity 完全消失 → 削除
  }

  @Test("reconcileAll: 生存 sessionId 一致なら task はそのまま (sessionID 維持)")
  func reconcileKeepsLiveSession() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "active", worktreeDir: env.worktreeA,
      prNumber: 0, issueNumber: 0
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    // 生存 sessionId として claude-sessions.json を用意する
    try writeClaudeSessions(
      configDir: env.configDir, dir: env.worktreeA,
      entries: [("live", env.worktreeA, "/tmp/dummy-transcript.jsonl")]
    )

    let failed = try await store.reconcileAll()
    #expect(failed.isEmpty)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.sessionID == "live")
  }
}

// MARK: - test helpers

private struct TaskStoreTestEnv {
  let configDir: String
  let mainRepo: String
  let worktreeA: String
  let worktreeB: String
}

private func makeEnv() async throws -> TaskStoreTestEnv {
  let base = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-task-store-\(UUID().uuidString.prefix(8))")
  let mainRepo = base.appendingPathComponent("main").path
  let worktreeA = base.appendingPathComponent("wt-a").path
  let worktreeB = base.appendingPathComponent("wt-b").path
  let configDir = base.appendingPathComponent("config").path

  let fm = FileManager.default
  for path in [mainRepo, configDir] {
    try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
  }

  try await runTestGit(args: ["init", "-q", "-b", "main"], cwd: mainRepo)
  try await runTestGit(args: ["config", "user.email", "test@example.com"], cwd: mainRepo)
  try await runTestGit(args: ["config", "user.name", "Test"], cwd: mainRepo)
  try await runTestGit(args: ["commit", "-q", "--allow-empty", "-m", "init"], cwd: mainRepo)
  try await runTestGit(args: ["worktree", "add", "-q", "-B", "wt-a", worktreeA], cwd: mainRepo)
  try await runTestGit(args: ["worktree", "add", "-q", "-B", "wt-b", worktreeB], cwd: mainRepo)

  return TaskStoreTestEnv(
    configDir: configDir, mainRepo: mainRepo, worktreeA: worktreeA, worktreeB: worktreeB)
}

private func cleanup(_ env: TaskStoreTestEnv) {
  let base = (env.configDir as NSString).deletingLastPathComponent
  try? FileManager.default.removeItem(atPath: base)
}

/// テスト helper: stdout は捨て、stderr を捕捉して non-zero exit を例外化する。
/// GitOpsTests.runTestGit と同じ流儀 (「テストヘルパーも本体と同じ厳密さ」原則)。
/// 未読 Pipe で `waitUntilExit` が deadlock するのを避けるため、stderr は
/// terminationHandler 内で `readDataToEndOfFile()` する。stdout は `nullDevice` に
/// 直接捨てる (git 出力は本テストで未使用)。
private func runTestGit(args: [String], cwd: String) async throws {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    process.environment = ProcessInfo.processInfo.environment
    process.standardOutput = FileHandle.nullDevice
    let stderrPipe = Pipe()
    process.standardError = stderrPipe
    process.terminationHandler = { proc in
      if proc.terminationStatus == 0 {
        cont.resume()
      } else {
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr =
          String(bytes: stderrData, encoding: .utf8)
          ?? "<non-UTF8 stderr (\(stderrData.count) bytes)>"
        cont.resume(
          throwing: GitError.commandFailed(exitCode: proc.terminationStatus, stderr: stderr))
      }
    }
    do {
      try process.run()
    } catch {
      cont.resume(throwing: error)
    }
  }
}

// projectKey の解決方式に合わせて claude-sessions.json を tasks.json と同じ projectDir に
// 書き込む。reconcileAll は projects/<projectKey>/claude-sessions.json を参照する。
private func writeClaudeSessions(
  configDir: String, dir: String, entries: [(sessionId: String, worktreePath: String, transcript: String)]
) throws {
  let projectKey = ProjectKey.resolveAndCompute(for: dir)
  let projectDir = (configDir as NSString)
    .appendingPathComponent("projects").appending("/\(projectKey)")
  try FileManager.default.createDirectory(atPath: projectDir, withIntermediateDirectories: true)

  var list = Gozd_V1_ClaudeSessionList()
  for entry in entries {
    var session = Gozd_V1_ClaudeSession()
    session.sessionID = entry.sessionId
    session.worktreePath = entry.worktreePath
    session.transcriptPath = entry.transcript
    list.sessions.append(session)
  }
  let json = try list.jsonString()
  let path = (projectDir as NSString).appendingPathComponent("claude-sessions.json")
  try json.write(toFile: path, atomically: true, encoding: .utf8)
}
