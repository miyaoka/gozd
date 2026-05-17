import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("TaskStore")
struct TaskStoreTests {
  // MARK: - add (upsert)

  @Test("add: 同 worktreeDir + 同 ghRef の既存 hidden task は再活性化される (PR/issue 再選択)")
  func addUpsertsHiddenGhRefTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "old title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live-sid", worktreeDir: env.worktreeA)
    // terminal close 相当: hidden=true
    try await store.detachSession(dir: env.worktreeA, sessionId: "live-sid")

    // PR picker から再選択 (タイトル変更を想定): upsert で hidden 解除 + body 上書き
    let revived = try await store.add(
      dir: env.worktreeA, body: "new title", worktreeDir: env.worktreeA,
      ghRef: .forPr(7), createdAt: "2026-05-20T00:00:00Z"
    )

    #expect(revived.id == original.id) // 同一 task identity を維持
    #expect(revived.body == "new title")
    #expect(!revived.hidden)
    #expect(revived.sessionID == "live-sid") // sessionID も保持される

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1) // 重複追加されない
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

    #expect(a.id != b.id) // worktreeDir が違えば upsert されない
  }

  // MARK: - attachSession

  @Test("attachSession: 既に同 sessionID の task があれば no-op (重複 hook / 復元レース)")
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

  @Test("attachSession: 同 sessionID 再 attach は hidden=true なら hidden=false に倒して蘇生 (resume 復帰)")
  func attachSessionResumeRevivesHidden() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    let original = try await store.add(
      dir: env.worktreeA, body: "PR #11", worktreeDir: env.worktreeA, ghRef: .forPr(11)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "first", worktreeDir: env.worktreeA)
    // terminal close: hidden=true + sessionID 保持
    try await store.detachSession(dir: env.worktreeA, sessionId: "first")
    #expect(try await store.list(dir: env.worktreeA).first?.hidden == true)

    // `claude --resume first` で同 sessionID の SessionStart hook が着弾。
    // 同一セッションの継続が確定しているため hidden=false に倒してサイドバー
    // 表示を復活させる。sessionID / body / id / createdAt は維持。
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "first", worktreeDir: env.worktreeA)

    let revived = try #require(try await store.list(dir: env.worktreeA).first)
    #expect(!revived.hidden)
    #expect(revived.sessionID == "first")
    #expect(revived.body == "PR #11")
    #expect(revived.id == original.id)
    #expect(revived.createdAt == original.createdAt)
  }

  @Test("attachSession: hidden=false な同 sessionID 再 attach は no-op (重複 hook)")
  func attachSessionIdempotentWhenNotHidden() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "PR #12", worktreeDir: env.worktreeA, ghRef: .forPr(12)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    let kept = try #require(try await store.list(dir: env.worktreeA).first)
    #expect(!kept.hidden)
    #expect(kept.sessionID == "live")
    #expect(try await store.list(dir: env.worktreeA).count == 1)
  }

  @Test("attachSession: hidden=true な ghRef task はピックアップ候補から外れる (素 claude 取り憑き防止)")
  func attachSessionSkipsHiddenCandidates() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // hidden=true な ghRef task を仕込む (terminal close 後の滞留状態)
    _ = try await store.add(
      dir: env.worktreeA, body: "PR #10", worktreeDir: env.worktreeA, ghRef: .forPr(10),
      createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "old", worktreeDir: env.worktreeA)
    try await store.detachSession(dir: env.worktreeA, sessionId: "old")
    // 滞留 task: hidden=true, sessionID="old"

    // 同 worktree で別経路から素 claude を起動 → 新 sid の SessionStart hook 着弾
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "fresh", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    // PR #10 task は触られない (hidden 維持 + 元 sessionID 維持)
    let ghTask = try #require(list.first(where: { $0.hasGhRef }))
    #expect(ghTask.hidden)
    #expect(ghTask.sessionID == "old")
    #expect(ghTask.body == "PR #10")
    // 新 sid は別の新規 task として作成される
    let freshTask = try #require(list.first(where: { $0.sessionID == "fresh" }))
    #expect(!freshTask.hasGhRef)
    #expect(freshTask.id != ghTask.id)
  }

  @Test("attachSession + clearDeadSession(markHiddenIfGhRef=false): 自動転移で同一 task に新 sid attach + hidden=false 維持")
  func attachSessionAutoTransferAfterFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    // 元 task: ghRef=#42, sessionID=X attach 済み (hidden=false 状態)
    let original = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42),
      createdAt: "2026-05-15T00:00:00Z"
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "X", worktreeDir: env.worktreeA)

    // session-start fallback 経路: hidden 据え置きで sessionID だけクリア
    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "X", markHiddenIfGhRef: false)

    // 直後の attachSession(Y) が hidden=false な ghRef task をピックして自動転移
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "Y", worktreeDir: env.worktreeA)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1) // 新規 task は作られない
    let kept = try #require(list.first)
    #expect(kept.id == original.id) // 同一 task に転移
    #expect(kept.sessionID == "Y")
    #expect(!kept.hidden) // hidden=false 維持
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
    // wtB 向けの task は attach されず、wtA 向けに新規 task が追加されている
    let foreignResult = list.first { $0.id == foreign.id }
    #expect(foreignResult?.sessionID == "")
    let attachedToA = list.first { $0.worktreeDir == env.worktreeA && $0.sessionID == "for-a" }
    #expect(attachedToA != nil)
  }

  // MARK: - detachSession

  @Test("detachSession: gh_ref が空なら task 削除 (Claude 直接起動 + 即終了の残骸)")
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

  @Test("detachSession: body だけでは task 残らない (body は揮発メタデータ。gh_ref のみ identity 源)")
  func detachSessionDropsBodyOnly() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "Refactor X", worktreeDir: env.worktreeA,
      ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "live")

    // body しか持たない task は ghRef 無しなので detach で削除される。
    // これにより root wt 上で直接 claude を起動した task が terminal close 時に
    // 揮発する経路を担保する (root wt は git worktree remove されないため)。
    let list = try await store.list(dir: env.worktreeA)
    #expect(list.isEmpty)
  }

  @Test("detachSession: ghRef があれば task を残しつつ hidden=true で表示だけ消す")
  func detachSessionKeepsPrTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "", worktreeDir: env.worktreeA,
      ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "pr-sid", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "pr-sid")

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.kind == .pr)
    #expect(kept.ghRef.number == 42)
    #expect(kept.sessionID == "pr-sid") // resume 起点として sessionID は維持
    #expect(kept.hidden) // サイドバー表示は terminal close で消える
  }

  @Test("detachSession: sessionId 不一致なら no-op (silent return)")
  func detachSessionUnknownId() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA,
      ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.detachSession(dir: env.worktreeA, sessionId: "nonexistent")

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.count == 1)
    #expect(list.first?.sessionID == "live")
  }

  // MARK: - clearDeadSession (resume 失敗検出)

  @Test("clearDeadSession(markHiddenIfGhRef=true): ghRef ありなら sessionID 空 + hidden=true (terminal close 経路)")
  func clearDeadSessionKeepsGhRefTask() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA,
      ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markHiddenIfGhRef: true)

    let list = try await store.list(dir: env.worktreeA)
    let kept = try #require(list.first)
    #expect(kept.hasGhRef)
    #expect(kept.ghRef.number == 42)
    #expect(kept.body == "PR #42") // body は保持される
    #expect(kept.sessionID == "") // dead sid はクリアされる (次クリックで素の claude 起動経路)
    #expect(kept.hidden) // terminal close 経路はサイドバー表示も消す
  }

  @Test("clearDeadSession(markHiddenIfGhRef=false): hidden 据え置き (session-start fallback 経路)")
  func clearDeadSessionKeepsHiddenWhenFallback() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "PR #42", worktreeDir: env.worktreeA, ghRef: .forPr(42)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markHiddenIfGhRef: false)

    let kept = try #require(try await store.list(dir: env.worktreeA).first)
    #expect(kept.sessionID == "")
    #expect(!kept.hidden) // fallback 経路は hidden 据え置き (直後の attachSession で自動転移)
  }

  @Test("clearDeadSession: ghRef なしなら task ごと削除 (markHidden 値に関係なく)")
  func clearDeadSessionDropsBodyOnly() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "scratch", worktreeDir: env.worktreeA,
      ghRef: nil
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "dead-sid", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "dead-sid", markHiddenIfGhRef: true)

    let list = try await store.list(dir: env.worktreeA)
    #expect(list.isEmpty)
  }

  @Test("clearDeadSession: sessionId 不一致なら no-op")
  func clearDeadSessionUnknownId() async throws {
    let env = try await makeEnv()
    defer { cleanup(env) }
    let store = TaskStore(configDir: env.configDir)

    _ = try await store.add(
      dir: env.worktreeA, body: "alive", worktreeDir: env.worktreeA,
      ghRef: .forPr(1)
    )
    try await store.attachSession(
      dir: env.worktreeA, sessionId: "live", worktreeDir: env.worktreeA)

    try await store.clearDeadSession(
      dir: env.worktreeA, sessionId: "nonexistent", markHiddenIfGhRef: true)

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

