import Foundation
import Testing

@testable import GozdCore

// `.serialized` で直列実行する（issue #556 観測項目 4）。
// PTYManagerTests と同様、複数 PTY の並列 spawn を構造的に消すことで再発時の
// trace 解析（pid と test の対応復元）を容易にする。test 自体の決定性は AsyncStream-based
// barrier で確保するため CPU 競合を理由とした直列化ではないが、trace 解析容易性のために維持する。
//
// `.timeLimit(.minutes(1))` は production 側 bug (AsyncStream.exit が永久に来ない deadlock
// 等) で test が永久 hang するのを test framework 経由の fail に倒す breaker (issue #710 系譜)。
@Suite("PTYRegistry", .serialized, .timeLimit(.minutes(1)))
struct PTYRegistryTests {
  @Test("spawn は連番の ptyId を返し、onText / onExit が ID 付きで配送される")
  func spawnAndExitDispatch() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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

    // 両 PTY の exit event 到達まで決定的に待つ。AsyncStream FIFO が production の
    // text/exit 順序を保つため polling 不要。
    let (texts, _) = await bridge.consumeUntilExitedIds([id1, id2])
    #expect((texts[id1] ?? "").contains("hello"))
    #expect((texts[id2] ?? "").contains("world"))
  }

  @Test("kill 後に PTY が registry から自動削除される")
  func cleanupOnKill() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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

    // exit event 到達まで決定的に待つ。
    _ = await bridge.consumeUntilExitedIds([id])
    // remove は exit handler 経由で `Task { await self.remove }` で発火する。
    // actor 内の Continuation accessor で count==0 到達を待つ。
    await registry.awaitEmpty()
    #expect(await registry.count() == 0)
  }

  @Test("未知の ptyId への write / resize / kill は no-op")
  func unknownIdIsNoop() async {
    testTrace("started")
    defer { testTrace("ended") }
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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
    let bridge = PTYRegistryEventBridge()
    let registry = PTYRegistry(onText: bridge.onText, onExit: bridge.onExit)

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
// **suite 自体は `.serialized`**: 並列 spawn race を発火させる責務は test 内 `withThrowingTaskGroup`
// で 8 件を同時発射することが担っており、suite を並列実行に置く意義は無い (issue #710 系譜:
// suite 間並列を消して trace 解析容易性を上げる)。
// `.timeLimit(.minutes(1))` は production 側 deadlock 検出用 breaker。
@Suite("PTYRegistry.ConcurrentSpawn", .serialized, .timeLimit(.minutes(1)))
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

// PTY spawn の cwd 引数に渡す「確定的に存在する dir」。`NSTemporaryDirectory()` は
// macOS の per-user TMPDIR (`/var/folders/...`) を返し、グローバル `/tmp` と異なり
// マルチユーザー環境 / サンドボックスでも衝突しない ( CLAUDE.md 規約「`/tmp` を
// ハードコードしない、`NSTemporaryDirectory()` を使う」)。
private let testCwd = NSTemporaryDirectory()

private enum PTYRegistryTestEvent: Sendable {
  case text(UInt32, String)
  case exit(UInt32, PTYExitReason)
}

/// PTYRegistry の `onText` / `onExit` callback を AsyncStream に直結する test 用 bridge。
///
/// 設計目的:
///   - 過去設計 (EventCollector + NSLock + waitUntil polling) は production callback を
///     mutable snapshot に変換し、50ms tick で polling する確率的経路 (issue #710 系譜)
///   - 本 bridge は production callback を AsyncStream に直結し、`consumeUntilExitedIds`
///     で「N 件の id が exit するまで」を決定的に待つ。polling 0 段、timeout 0 段
///   - 永久 suspend は suite trait `.timeLimit(.minutes(1))` が breaker として吸収する
///
/// **単一 consumer 契約**: `stream` は 1 度だけ iterate すること (`consumeUntilExitedIds`
/// 1 回 または `for await` 1 回)。AsyncStream は single-consumer 契約のため 2 度目の
/// iteration は未定義動作 (Apple Doc: "iterating an `AsyncStream` more than once results
/// in undefined behavior")。複数 phase の event 観察には別 bridge インスタンスを使う。
private final class PTYRegistryEventBridge: Sendable {
  let onText: @Sendable (UInt32, String) -> Void
  let onExit: @Sendable (UInt32, PTYExitReason) -> Void
  let stream: AsyncStream<PTYRegistryTestEvent>

  init() {
    let (stream, continuation) = AsyncStream<PTYRegistryTestEvent>.makeStream()
    self.stream = stream
    self.onText = { continuation.yield(.text($0, $1)) }
    self.onExit = { continuation.yield(.exit($0, $1)) }
    // continuation.finish() はここでは呼ばない (複数 PTY の exit を順に受ける)。
    // consumeUntilExitedIds が break で iteration を終了する。
  }

  /// 指定された id 全てが exit するまで event を accumulate する。
  /// 戻り値は (id → 累積 text, id → exit reason)。
  func consumeUntilExitedIds(_ targetIds: [UInt32])
    async -> (texts: [UInt32: String], exits: [UInt32: PTYExitReason])
  {
    let targetSet = Set(targetIds)
    var texts: [UInt32: String] = [:]
    var exits: [UInt32: PTYExitReason] = [:]
    for await event in stream {
      switch event {
      case .text(let id, let text):
        texts[id, default: ""].append(text)
      case .exit(let id, let reason):
        exits[id] = reason
      }
      if targetSet.isSubset(of: Set(exits.keys)) { break }
    }
    return (texts, exits)
  }
}
