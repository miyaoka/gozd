import Foundation
import Testing

@testable import GozdCore

// `.serialized` で直列実行する（issue #556 観測項目 4）。
// PTYManagerTests と同様、複数 PTY の並列 spawn を構造的に消すことで再発時の
// trace 解析（pid と test の対応復元）を容易にする。
// PTY を spawn する suite を跨いだ並列実行も避けるため、両 suite を揃って直列化する。
@Suite("PTYRegistry", .serialized)
struct PTYRegistryTests {
  @Test("spawn は連番の ptyId を返し、onText / onExit が ID 付きで配送される")
  func spawnAndExitDispatch() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    let id1 = try await registry.spawn(
      executable: "/bin/echo",
      args: ["echo", "hello"],
      env: ProcessInfo.processInfo.environment,
      cwd: testCwd,
      rows: 24,
      cols: 80
    )
    let id2 = try await registry.spawn(
      executable: "/bin/echo",
      args: ["echo", "world"],
      env: ProcessInfo.processInfo.environment,
      cwd: testCwd,
      rows: 24,
      cols: 80
    )
    // ptyId 採番の不変条件「成功 spawn 時に nextId は +1 だけ進む」をここで担保する。
    // `peekNextId()` 専用 seam を test 用に公開する案を以前持っていたが、
    // module API に test-only accessor を漏らすコストを避けるため撤去し、配送機構
    // test である本 test の副次 assertion に統合した（PR #597 review feedback）。
    #expect(id2 == id1 + 1)

    await waitUntil(timeout: .seconds(3)) {
      events.exitedIds().contains(id1) && events.exitedIds().contains(id2)
    }

    #expect(events.textFor(id: id1).contains("hello"))
    #expect(events.textFor(id: id2).contains("world"))
  }

  @Test("kill 後に PTY が registry から自動削除される")
  func cleanupOnKill() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    let id = try await registry.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: testCwd,
      rows: 24,
      cols: 80
    )
    #expect(await registry.count() == 1)

    await registry.kill(id: id)

    await waitUntil(timeout: .seconds(2)) {
      events.exitedIds().contains(id)
    }
    // remove は exit handler 経由で `Task { await self.remove }` で発火する。
    // actor 内の Continuation accessor で count==0 到達を待つ。
    await registry.awaitEmpty()
    #expect(await registry.count() == 0)
  }

  @Test("未知の ptyId への write / resize / kill は no-op")
  func unknownIdIsNoop() async {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    await registry.write(id: 9999, data: Data("ping\n".utf8))
    await registry.resize(id: 9999, rows: 50, cols: 100)
    await registry.kill(id: 9999)
    // ここまで例外なく到達すれば OK
    #expect(await registry.count() == 0)
  }

  // MARK: - expected resume sid lifecycle

  @Test("spawn 時 env[GOZD_RESUME_CLAUDE_SESSION] が expectedResumeSidById に保存される")
  func expectedResumeSidPopulatedFromEnv() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "expected-sid-X"
    let id = try await registry.spawn(
      executable: "/bin/cat", args: ["cat"], env: env, cwd: testCwd, rows: 24, cols: 80
    )
    defer { Task { await registry.kill(id: id) } }

    // SessionStart 不達のまま consume すれば expected が返る (= resume 失敗判定)
    let consumed = await registry.consumeExpectedResumeSid(for: id)
    #expect(consumed == "expected-sid-X")
    // 2 回目の consume は空 (1 回消費したら消える)
    let second = await registry.consumeExpectedResumeSid(for: id)
    #expect(second == nil)
  }

  @Test("consumeExpectedResumeSid は sid 関係なく必ず消費する (SessionStart 着弾の単一エントリポイント)")
  func consumeExpectedSidAlwaysConsumes() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "expected-sid-X"
    let id = try await registry.spawn(
      executable: "/bin/cat", args: ["cat"], env: env, cwd: testCwd, rows: 24, cols: 80
    )
    defer { Task { await registry.kill(id: id) } }

    // SessionStart 着弾相当: 別 sid (zsh fallback で素 claude が新 sid を発行したケース) でも
    // expected は必ず消費される。caller は返り値を hook.sessionID と比較して
    // 一致/不一致を判定する。
    let consumed = await registry.consumeExpectedResumeSid(for: id)
    #expect(consumed == "expected-sid-X")

    // 2 回目の consume は nil (1 回消費したら消える)。removeByPty 経路で再観測しないことを保証。
    let second = await registry.consumeExpectedResumeSid(for: id)
    #expect(second == nil)
  }

  @Test("clearAssociations は expectedResumeSid を触らない (silent drop しない契約)")
  func clearAssociationsLeavesExpectedSid() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let events = EventCollector()
    let registry = PTYRegistry(
      onText: { id, text in events.appendText(id: id, text: text) },
      onExit: { id, reason in events.appendExit(id: id, reason: reason) }
    )

    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "expected-sid-X"
    let id = try await registry.spawn(
      executable: "/bin/cat", args: ["cat"], env: env, cwd: testCwd, rows: 24, cols: 80
    )
    defer { Task { await registry.kill(id: id) } }

    // clearAssociations は worktreePath / sessionId / explicitlyRemoved 管理のみ。
    // expected は呼び出し側で consumeExpectedResumeSid して片付ける契約。
    await registry.clearAssociations(for: id)
    let stillThere = await registry.consumeExpectedResumeSid(for: id)
    #expect(stillThere == "expected-sid-X")
  }
}

// `PTYRegistry.spawn` は actor isolated method で内部に `await awaitReadyPipe(fd:)` を
// 持つ。actor は `await` ごとに re-entrancy を許す (SE-0306) ため、id 採番 / `ptys[id]`
// 登録 / `pidTracker` 加入は全て suspend point の **前** で完了する不変条件を持つ。
// この suite はその不変条件が並列 spawn でも保たれることを直接 verify する。
//
// 親 suite `PTYRegistry` は `.serialized` で直列化されており、並列 spawn の race は
// 構造的に踏めない。本 suite は default の parallel 実行に置き、`withThrowingTaskGroup`
// で複数 spawn を同時発射した時の id 採番一意性を assert する。
@Suite("PTYRegistry.ConcurrentSpawn")
struct PTYRegistryConcurrentSpawnTests {
  @Test("並列 spawn が一意な ptyId を採番し、並列 remove が actor 上で整合する")
  func concurrentSpawnYieldsUniqueIds() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let registry = PTYRegistry(
      onText: { _, _ in },
      onExit: { _, _ in }
    )

    let count = 8
    let ids = try await withThrowingTaskGroup(of: UInt32.self) { group in
      for _ in 0..<count {
        group.addTask {
          try await registry.spawn(
            executable: "/bin/echo",
            args: ["echo", "race"],
            env: ProcessInfo.processInfo.environment,
            cwd: testCwd,
            rows: 24,
            cols: 80
          )
        }
      }
      var collected: [UInt32] = []
      for try await id in group {
        collected.append(id)
      }
      return collected
    }

    // 主観点: id 採番一意性 ( actor re-entrancy 経由の `ptys[id]` 上書き race の regression
    // guard )。
    #expect(ids.count == count)
    #expect(
      Set(ids).count == count,
      "expected \(count) unique ids, got duplicates in \(ids.sorted())")

    // 副観点: `/bin/echo` × 8 件は即時 _exit するため、8 つの consumer Task が並列に
    // `remove(id:)` を actor に発射する。`awaitEmpty()` の Continuation flush が並列
    // remove 経路でも `ptys.isEmpty` 確定後に 1 度だけ resume されることをここで合わせて
    // 担保する ( single-pty の `cleanupOnKill` test では並列 remove を踏めない )。
    await registry.awaitEmpty()
    #expect(await registry.count() == 0)
  }
}

// MARK: - Helpers

// `waitUntil` は `WaitUntil.swift` の共有実装 ( dedicated NSThread 上で polling loop を完結 )。
// tick polling 履歴を保持し、timeout 時に Issue.record の message に inline する。

// PTY spawn の cwd 引数に渡す「確定的に存在する dir」。`NSTemporaryDirectory()` は
// macOS の per-user TMPDIR (`/var/folders/...`) を返し、グローバル `/tmp` と異なり
// マルチユーザー環境 / サンドボックスでも衝突しない ( CLAUDE.md 規約「`/tmp` を
// ハードコードしない、`NSTemporaryDirectory()` を使う」)。
private let testCwd = NSTemporaryDirectory()

private final class EventCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var textMap: [UInt32: String] = [:]
  private var exits: [UInt32: PTYExitReason] = [:]

  func appendText(id: UInt32, text: String) {
    lock.lock()
    defer { lock.unlock() }
    textMap[id, default: ""].append(text)
  }

  func appendExit(id: UInt32, reason: PTYExitReason) {
    lock.lock()
    defer { lock.unlock() }
    exits[id] = reason
  }

  func textFor(id: UInt32) -> String {
    lock.lock()
    defer { lock.unlock() }
    return textMap[id] ?? ""
  }

  func exitedIds() -> Set<UInt32> {
    lock.lock()
    defer { lock.unlock() }
    return Set(exits.keys)
  }
}
