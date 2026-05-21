import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("TaskStore")
struct TaskStoreTests {
  // MARK: - add (upsert)

  @Test("add: 同 worktreeDir + 同 ghRef の既存 task は再活性化される (PR/issue 再選択)")
  func addUpsertsClosedGhRefTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "old title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live-sid", worktreeDir: env.worktreeA)
    // terminal close 相当: closed_by_user=true
    try await store.detachSession(dir: env.worktreeA, sessionId: "live-sid")

    // PR picker から再選択 (タイトル変更を想定): upsert で closed 解除 + body 上書き
    let revived = try await store.add(
      dir: env.worktreeA, body: "new title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-20T00:00:00Z"
    )

    #expect(revived.id == original.id)
    #expect(revived.body == "new title")
    #expect(!revived.closedByUser)
    #expect(revived.sessionID == "live-sid")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
  }

  @Test("add: ghRef 無しは upsert せず常に新規作成")
  func addAlwaysCreatesWhenNoGhRef() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let first = try await store.add(
      dir: env.worktreeA, body: "scratch", worktreeDir: env.worktreeA, ghRef: nil
    )
    let second = try await store.add(
      dir: env.worktreeA, body: "scratch", worktreeDir: env.worktreeA, ghRef: nil
    )

    #expect(first.id != second.id)
    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 2)
  }

  @Test("add: 別 worktree の同 ghRef は別 task として扱う")
  func addScopesUpsertByWorktree() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let a = try await store.add(
      dir: env.worktreeA, body: "wt-a", worktreeDir: env.worktreeA, ghRef: .forPr(9)
    )
    let b = try await store.add(
      dir: env.worktreeA, body: "wt-b", worktreeDir: env.worktreeB, ghRef: .forPr(9)
    )

    #expect(a.id != b.id)
  }

  // MARK: - remove

  @Test("remove: 指定 id の task を削除")
  func removeDeletesById() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let task = try await store.add(
      dir: env.worktreeA, body: "scratch", worktreeDir: env.worktreeA, ghRef: nil
    )
    _ = try await store.add(
      dir: env.worktreeA, body: "other", worktreeDir: env.worktreeA, ghRef: nil
    )

    try await store.remove(dir: env.worktreeA, id: task.id)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.id != task.id)
  }

  @Test("remove: 存在しない id は no-op")
  func removeUnknownIdIsNoOp() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA, ghRef: nil
    )

    try await store.remove(dir: env.worktreeA, id: "nonexistent")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
  }

  // MARK: - attachSession

  @Test("attachSession: 既に同 sessionID の task があれば closed=false に戻して no-op (resume 復帰)")
  func attachSessionIdempotent() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let task = try await store.add(
      dir: env.worktreeA, body: "existing", worktreeDir: env.worktreeA,
      ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "s1", worktreeDir: env.worktreeA)

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "s1", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let attached = list.filter { $0.sessionID == "s1" }
    #expect(attached.count == 1)
    #expect(attached.first?.id == task.id)
    #expect(attached.first?.closedByUser == false)
  }

  @Test("attachSession: sessionId 空の最新 task に attach + closed=false を立てる")
  func attachSessionPicksLatestEmpty() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let older = try await store.add(
      dir: env.worktreeA, body: "older", worktreeDir: env.worktreeA,
      ghRef: nil, createdAt: "2026-05-15T00:00:00Z"
    )
    let newer = try await store.add(
      dir: env.worktreeA, body: "newer", worktreeDir: env.worktreeA,
      ghRef: nil,
      createdAt: "2026-05-16T00:00:00Z"
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let olderResult = list.first { $0.id == older.id }
    let newerResult = list.first { $0.id == newer.id }
    #expect(olderResult?.sessionID == "")
    #expect(newerResult?.sessionID == "fresh")
    #expect(newerResult?.closedByUser == false)
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
    #expect(task.id != "lone")
    #expect(!task.id.isEmpty)
    #expect(!task.closedByUser)
  }

  @Test("attachSession: 同 sessionID 再 attach は closed=true を closed=false に倒して蘇生 (resume 復帰)")
  func attachSessionResumeRevivesClosed() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "PR #11", worktreeDir: env.worktreeA, ghRef: .forPr(11)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "first", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "first")
    #expect(try await store.list(dir: env.worktreeA).first?.closedByUser == true)

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "first", worktreeDir: env.worktreeA)

    let revived = try #require(try await store.list(dir: env.worktreeA).first)
    #expect(!revived.closedByUser)
    #expect(revived.sessionID == "first")
    #expect(revived.body == "PR #11")
    #expect(revived.id == original.id)
    #expect(revived.createdAt == original.createdAt)
  }

  @Test("attachSession + clearDeadSession(markClosedByUser=false): 自動転移で同一 task に新 sid attach")
  func attachSessionAutoTransferAfterFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42),
      createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "X", worktreeDir: env.worktreeA)

    // session-start fallback 経路: closed_by_user 据え置きで sessionID だけクリア
    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "X", markClosedByUser: false)

    // 直後の attachSession(Y) が sessionID 空の同 worktree task をピックして自動転移
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "Y", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    let kept = try #require(list.first)
    #expect(kept.id == original.id)
    #expect(kept.sessionID == "Y")
    #expect(!kept.closedByUser)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.number == 42)
  }

  @Test("attachSession: 他 worktree の sessionId 空 task は attach 対象外")
  func attachSessionScopedByWorktreeDir() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let foreign = try await store.add(
      dir: env.worktreeA, body: "for-b", worktreeDir: env.worktreeB,
      ghRef: nil
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "for-a", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let foreignResult = list.first { $0.id == foreign.id }
    #expect(foreignResult?.sessionID == "")
    let attachedToA = list.first { $0.worktreeDir == env.worktreeA && $0.sessionID == "for-a" }
    #expect(attachedToA != nil)
  }

  // MARK: - detachSession

  @Test("detachSession: ghRef 無し task も残し、sessionID 保持 + closed_by_user=true")
  func detachSessionKeepsBodyOnly() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "Refactor X", worktreeDir: env.worktreeA, ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "live")

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.id == original.id)
    #expect(kept.sessionID == "live")
    #expect(kept.closedByUser)
    #expect(kept.body == "Refactor X")
  }

  @Test("detachSession: ghRef 有り task も同じ動き (sessionID 保持 + closed_by_user=true)")
  func detachSessionKeepsPrTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "", worktreeDir: env.worktreeA, ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "pr-sid", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "pr-sid")

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.number == 42)
    #expect(kept.sessionID == "pr-sid")
    #expect(kept.closedByUser)
  }

  @Test("detachSession: sessionId 不一致なら no-op (silent return)")
  func detachSessionUnknownId() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA, ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "nonexistent")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.sessionID == "live")
    #expect(list.first?.closedByUser == false)
  }

  // MARK: - clearDeadSession (resume 失敗検出)

  @Test("clearDeadSession(markClosedByUser=true): sessionID 空 + closed_by_user=true (terminal close 経路)")
  func clearDeadSessionMarksClosed() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markClosedByUser: true)

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.number == 42)
    #expect(kept.body == "PR #42")
    #expect(kept.sessionID == "")
    #expect(kept.closedByUser)
  }

  @Test("clearDeadSession(markClosedByUser=false): closed_by_user 据え置き (session-start fallback)")
  func clearDeadSessionKeepsClosedFlagWhenFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markClosedByUser: false)

    let kept = try #require(try await store.list(dir: env.worktreeA).first)
    #expect(kept.sessionID == "")
    #expect(!kept.closedByUser)
  }

  @Test("clearDeadSession: ghRef なしも task は残す (sessionID だけ空に)")
  func clearDeadSessionKeepsBodyOnly() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "scratch", worktreeDir: env.worktreeA, ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markClosedByUser: true)

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.id == original.id)
    #expect(kept.sessionID == "")
    #expect(kept.closedByUser)
  }

  @Test("attachSession: candidate に closedByUser=true な task を含める (素 claude 再起動で closed task を蘇生)")
  func attachSessionRevivesClosedCandidate() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // root wt で素 claude を起動 → /exit (closed_by_user=true で滞留)
    let original = try await store.add(
      dir: env.worktreeA, body: "scratch work", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "old-sid", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "old-sid")
    #expect(try await store.list(dir: env.worktreeA).first?.closedByUser == true)

    // 同 worktree で再度素 claude を起動 → SessionStart hook が新 sid で着弾。
    // candidate に closedByUser=true を含めたことで、新規 task が増えず元 task に転移する。
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "new-sid", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    let revived = try #require(list.first)
    #expect(revived.id == original.id)
    #expect(revived.sessionID == "new-sid")
    #expect(!revived.closedByUser)
    #expect(revived.body == "scratch work")
  }

  @Test("attachSession: ghRef 有り closed task に素 claude (新 sid) が attach した時、body / ghRef は触らず sessionID と closedByUser だけ書き換える (設計判断: ghRef 有無で attach 動作を分岐せず、同 worktree のアクセス継続性を優先)")
  func attachSessionRevivesGhRefClosedTaskWithoutOverwritingIdentity() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // PR picker で PR #42 task を作成 → SessionStart で sid=X attach
    let original = try await store.add(
      dir: env.worktreeA, body: "PR #42 title", worktreeDir: env.worktreeA,
      ghRef: .forPr(42), createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "X", worktreeDir: env.worktreeA)
    // terminal close: ghRef + sessionID 保持 + closedByUser=true
    try await store.detachSession(dir: env.worktreeA, sessionId: "X")

    // 同 worktree で PR picker を経由せず素 claude を起動 → SessionStart hook で sid=Y 着弾。
    // priority 2 の candidate (sessionID 空 OR closedByUser=true) で当該 ghRef closed task
    // が pick される。
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "Y", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    let pickedTask = try #require(list.first)
    // 同一 task identity を維持 (id / createdAt / body / ghRef)
    #expect(pickedTask.id == original.id)
    #expect(pickedTask.createdAt == original.createdAt)
    #expect(pickedTask.body == "PR #42 title")
    #expect(pickedTask.hasGhRef)
    #expect(pickedTask.ghRef.number == 42)
    // sessionID と closedByUser だけが書き換わる
    #expect(pickedTask.sessionID == "Y")
    #expect(!pickedTask.closedByUser)
    // ※ サイドバー UI 上は「PR #42 title」と表示されるが、Claude セッション Y は PR 文脈を
    // 持たない可能性がある。ghRef 有無で attach を分岐させない設計判断によるトレードオフ。
  }

  @Test("attachSession: sessionID 空 task と closed task が並ぶ場合、createdAt 最新を pick")
  func attachSessionPicksLatestAmongMixedCandidates() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // 古い closed task
    let older = try await store.add(
      dir: env.worktreeA, body: "older closed", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-10T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "old-sid", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "old-sid")

    // 新しい sessionID 空 task
    let newer = try await store.add(
      dir: env.worktreeA, body: "newer empty", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-20T00:00:00Z"
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let olderResult = try #require(list.first { $0.id == older.id })
    let newerResult = try #require(list.first { $0.id == newer.id })
    // newer (createdAt 最新) がピックされる
    #expect(newerResult.sessionID == "fresh")
    #expect(!newerResult.closedByUser)
    // older は触られない
    #expect(olderResult.sessionID == "old-sid")
    #expect(olderResult.closedByUser)
  }

  @Test("attachSession: createdAt 同値の candidate は id 辞書順で最大の方を pick (決定論的 tie-break)")
  func attachSessionTieBreaksOnIdWhenCreatedAtEqual() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // 同 createdAt の sessionID 空 task を 2 つ作る (1 秒以内に複数 task を作る再現)
    let sameTime = "2026-05-15T00:00:00Z"
    let a = try await store.add(
      dir: env.worktreeA, body: "A", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: sameTime
    )
    let b = try await store.add(
      dir: env.worktreeA, body: "B", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: sameTime
    )

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    let attached = try #require(list.first { $0.sessionID == "fresh" })
    // tie-break: id 辞書順で最大値 (= 大きい方) を pick
    let expectedWinnerId = a.id > b.id ? a.id : b.id
    #expect(attached.id == expectedWinnerId)
  }

  @Test("clearDeadSession: sessionId 不一致なら no-op")
  func clearDeadSessionUnknownId() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA, ghRef: .forPr(1)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "nonexistent", markClosedByUser: true)

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
