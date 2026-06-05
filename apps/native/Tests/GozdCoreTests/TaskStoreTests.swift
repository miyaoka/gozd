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
      dir: env.worktreeA, ghTitle: "old title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live-sid", worktreeDir: env.worktreeA)
    // terminal close 相当: closed_by_user=true
    try await store.detachSession(dir: env.worktreeA, sessionId: "live-sid")

    // PR picker から再選択 (タイトル変更を想定): upsert で closed 解除 + gh_title 上書き
    let revived = try await store.add(
      dir: env.worktreeA, ghTitle: "new title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-20T00:00:00Z"
    )

    #expect(revived.id == original.id)
    #expect(revived.ghTitle == "new title")
    #expect(revived.userTitle == "")
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
    )
    let second = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
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
      dir: env.worktreeA, ghTitle: "wt-a", worktreeDir: env.worktreeA, ghRef: .forPr(9)
    )
    let b = try await store.add(
      dir: env.worktreeA, ghTitle: "wt-b", worktreeDir: env.worktreeB, ghRef: .forPr(9)
    )

    #expect(a.id != b.id)
  }

  // MARK: - resumableSessionIds

  @Test("resumableSessionIds: sessionId 非空 + !closedByUser + worktreeDir 一致の task だけ返す")
  func resumableSessionIdsFiltersByAllBoundaries() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // task1 (A, sid 有, !closed) → resume 対象
    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "a1", worktreeDir: env.worktreeA, ghRef: .forPr(1))
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "sid-a1", worktreeDir: env.worktreeA)
    // task2 (A, sid 有, closed) → 除外 (closedByUser)
    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "a2", worktreeDir: env.worktreeA, ghRef: .forPr(2))
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "sid-a2", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "sid-a2")
    // task3 (A, sid 空) → 除外 (sessionId 空)
    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "a3", worktreeDir: env.worktreeA, ghRef: .forPr(3))
    // task4 (B, sid 有, !closed) → 除外 (worktreeDir 不一致。list は projectKey 単位で
    // 全 worktree の task を返すため、worktreeDir 絞り込みが効かないと別 worktree の
    // session を resume してしまう)
    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "b1", worktreeDir: env.worktreeB, ghRef: .forPr(4))
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "sid-b1", worktreeDir: env.worktreeB)

    let resumable = try await store.resumableSessionIds(dir: env.worktreeA)
    #expect(resumable == ["sid-a1"])
  }

  // MARK: - remove

  @Test("remove: 指定 id の task を削除")
  func removeDeletesById() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let task = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
    )
    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA,
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA,
      ghRef: nil, createdAt: "2026-05-15T00:00:00Z"
    )
    let newer = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA,
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
    #expect(task.userTitle == "")
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
      dir: env.worktreeA, ghTitle: "PR #11", worktreeDir: env.worktreeA, ghRef: .forPr(11)
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
    #expect(revived.ghTitle == "PR #11")
    #expect(revived.id == original.id)
    #expect(revived.createdAt == original.createdAt)
  }

  @Test("attachSession + clearDeadSession(markClosedByUser=false): 自動転移で同一 task に新 sid attach")
  func attachSessionAutoTransferAfterFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42),
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeB,
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
    )
    // ユーザーが dialog で user_title を編集した状態を作り、detach 後も保持されることを検証
    _ = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "Refactor X")
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "live")

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.id == original.id)
    #expect(kept.sessionID == "live")
    #expect(kept.closedByUser)
    #expect(kept.userTitle == "Refactor X")
  }

  @Test("detachSession: ghRef 有り task も同じ動き (sessionID 保持 + closed_by_user=true)")
  func detachSessionKeepsPrTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: .forPr(42)
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
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
      dir: env.worktreeA, ghTitle: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markClosedByUser: true)

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.number == 42)
    #expect(kept.ghTitle == "PR #42")
    #expect(kept.sessionID == "")
    #expect(kept.closedByUser)
  }

  @Test("clearDeadSession(markClosedByUser=false): closed_by_user 据え置き (session-start fallback)")
  func clearDeadSessionKeepsClosedFlagWhenFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, ghTitle: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42)
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
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil
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

  @Test("attachSession: closed (sid 保持) task は奪わず、新 sid は別 task を作る (hijack なし)")
  func attachSessionDoesNotHijackClosedTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // 素 claude を起動 → /exit (sessionID 保持 + closed_by_user=true で滞留 = resume 可能)
    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-15T00:00:00Z"
    )
    _ = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "scratch work")
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "old-sid", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "old-sid")
    #expect(try await store.list(dir: env.worktreeA).first?.closedByUser == true)

    // 同 worktree で再度素 claude を起動 → SessionStart hook が新 sid で着弾。
    // closed task は sessionID を保持する (resume 可能) ため candidate にせず、新 task を作る。
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "new-sid", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 2)
    // 旧 task は closed (sid=old-sid) のまま resume 可能で残る
    let kept = try #require(list.first { $0.id == original.id })
    #expect(kept.sessionID == "old-sid")
    #expect(kept.closedByUser)
    #expect(kept.userTitle == "scratch work")
    // 新 session_id は別 task になる
    let fresh = try #require(list.first { $0.id != original.id })
    #expect(fresh.sessionID == "new-sid")
    #expect(!fresh.closedByUser)
  }

  @Test("attachSession: ghRef 有り closed task も奪わず、素 claude (新 sid) は別 task を作る (gh 情報を持つ resume 可能 task を保護)")
  func attachSessionDoesNotHijackGhRefClosedTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // PR picker で PR #42 task を作成 → SessionStart で sid=X attach
    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "PR #42 title", worktreeDir: env.worktreeA,
      ghRef: .forPr(42), createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "X", worktreeDir: env.worktreeA)
    // terminal close: ghRef + sessionID 保持 + closedByUser=true
    try await store.detachSession(dir: env.worktreeA, sessionId: "X")

    // 同 worktree で PR picker を経由せず素 claude を起動 → SessionStart hook で sid=Y 着弾。
    // closed ghRef task は sessionID を保持する (resume 可能) ため奪わず、別 task を作る。
    // これで PR #42 の resume 経路 (gh 情報込み) が温存される。
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "Y", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 2)
    // PR #42 task は closed (sid=X, ghRef 保持) のまま残る
    let prTask = try #require(list.first { $0.id == original.id })
    #expect(prTask.sessionID == "X")
    #expect(prTask.closedByUser)
    #expect(prTask.hasGhRef)
    #expect(prTask.ghRef.number == 42)
    #expect(prTask.ghTitle == "PR #42 title")
    // 素 claude の新 session は ghRef を持たない別 task になる
    let fresh = try #require(list.first { $0.id != original.id })
    #expect(fresh.sessionID == "Y")
    #expect(!fresh.hasGhRef)
    #expect(!fresh.closedByUser)
  }

  @Test("attachSession: closed (sid 保持) task は createdAt が新しくても candidate 外、sessionID 空 task が pick される")
  func attachSessionExcludesClosedTaskWithSid() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // sessionID 空 task (古い) = 未起動 placeholder 相当
    let empty = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-10T00:00:00Z"
    )

    // closed task (新しい) — sid を保持 = resume 可能
    let closed = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: "2026-05-20T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "closed-sid", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "closed-sid")

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    // closed が createdAt 最新でも、sid 保持で candidate 外。sessionID 空の empty が pick される
    let emptyResult = try #require(list.first { $0.id == empty.id })
    #expect(emptyResult.sessionID == "fresh")
    #expect(!emptyResult.closedByUser)
    // closed は触られない
    let closedResult = try #require(list.first { $0.id == closed.id })
    #expect(closedResult.sessionID == "closed-sid")
    #expect(closedResult.closedByUser)
  }

  @Test("attachSession: createdAt 同値の candidate は id 辞書順で最大の方を pick (決定論的 tie-break)")
  func attachSessionTieBreaksOnIdWhenCreatedAtEqual() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // 同 createdAt の sessionID 空 task を 2 つ作る (1 秒以内に複数 task を作る再現)
    let sameTime = "2026-05-15T00:00:00Z"
    let a = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil,
      createdAt: sameTime
    )
    let b = try await store.add(
      dir: env.worktreeA, ghTitle: "", worktreeDir: env.worktreeA, ghRef: nil,
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
      dir: env.worktreeA, ghTitle: "alive", worktreeDir: env.worktreeA, ghRef: .forPr(1)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "nonexistent", markClosedByUser: true)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.sessionID == "live")
  }

  // MARK: - setUserTitle / setTerminalTitle (タイトル 3 レイヤ契約)

  @Test("setUserTitle: 任意値で user_title が書き換わり、gh_title / terminal_title は保持")
  func setUserTitleAssignsOnlyUserTitle() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "PR title", worktreeDir: env.worktreeA, ghRef: .forPr(1)
    )
    _ = try await store.setTerminalTitle(
      dir: env.worktreeA, id: original.id, terminalTitle: "claude (working)")

    let updated = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "my title")

    #expect(updated.userTitle == "my title")
    #expect(updated.ghTitle == "PR title")
    #expect(updated.terminalTitle == "claude (working)")
  }

  @Test("setUserTitle: 空文字で user_title をクリアし、gh_title / terminal_title はそのまま")
  func setUserTitleEmptyClearsUserTitleOnly() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "PR title", worktreeDir: env.worktreeA, ghRef: .forPr(1)
    )
    _ = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "edited")
    _ = try await store.setTerminalTitle(
      dir: env.worktreeA, id: original.id, terminalTitle: "term title")

    let reset = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "")

    #expect(reset.userTitle == "")
    #expect(reset.ghTitle == "PR title")
    #expect(reset.terminalTitle == "term title")
  }

  @Test("setUserTitle: 存在しない id は notFound を throw")
  func setUserTitleUnknownIdThrows() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    await #expect(throws: TaskStoreError.notFound("missing")) {
      _ = try await store.setUserTitle(
        dir: env.worktreeA, id: "missing", userTitle: "x")
    }
  }

  @Test("setTerminalTitle: terminal_title だけが書き換わり、user_title / gh_title は不変 (本 PR の構造的目的)")
  func setTerminalTitleDoesNotTouchOtherTitles() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "PR title", worktreeDir: env.worktreeA, ghRef: .forPr(1)
    )
    _ = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "user title")

    let updated = try await store.setTerminalTitle(
      dir: env.worktreeA, id: original.id, terminalTitle: "new term title")

    #expect(updated.terminalTitle == "new term title")
    #expect(updated.userTitle == "user title")
    #expect(updated.ghTitle == "PR title")
  }

  @Test("setTerminalTitle: 存在しない id は notFound を throw")
  func setTerminalTitleUnknownIdThrows() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    await #expect(throws: TaskStoreError.notFound("missing")) {
      _ = try await store.setTerminalTitle(
        dir: env.worktreeA, id: "missing", terminalTitle: "x")
    }
  }

  @Test("add upsert: 既存 task の user_title は picker 再選択で書き換わらない (ユーザー編集の確定値は保持)")
  func addUpsertPreservesExistingUserTitle() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, ghTitle: "original PR title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-15T00:00:00Z"
    )
    // ユーザーが dialog で user_title を編集した状態を作る
    _ = try await store.setUserTitle(
      dir: env.worktreeA, id: original.id, userTitle: "manual edit")

    // PR picker から再選択 (upsert): gh_title だけが上書き、user_title は保持される
    let revived = try await store.add(
      dir: env.worktreeA, ghTitle: "renamed PR title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-20T00:00:00Z"
    )

    #expect(revived.id == original.id)
    #expect(revived.ghTitle == "renamed PR title")
    #expect(revived.userTitle == "manual edit")
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
