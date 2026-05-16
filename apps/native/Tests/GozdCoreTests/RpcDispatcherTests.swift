import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("RpcDispatcher")
struct RpcDispatcherTests {
  @Test("/echo は EchoRequest を受けて EchoResponse を返す")
  func echo() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var req = Gozd_V1_EchoRequest()
    req.text = "world"
    let body = try req.jsonUTF8Data()

    let respData = try await dispatcher.dispatch(path: "/echo", body: body)
    let resp = try Gozd_V1_EchoResponse(jsonUTF8Data: respData)
    #expect(resp.text == "echo: world")
  }

  @Test("/appState/save → /appState/load で round-trip")
  func appStateRoundTrip() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var saveReq = Gozd_V1_SaveAppStateRequest()
    var state = Gozd_V1_AppState()
    state.lastOpenedDir = "/foo/bar"
    saveReq.state = state
    _ = try await dispatcher.dispatch(path: "/appState/save", body: saveReq.jsonUTF8Data())

    let loadReq = Gozd_V1_LoadAppStateRequest()
    let loadResp = try await dispatcher.dispatch(
      path: "/appState/load", body: loadReq.jsonUTF8Data())
    let parsed = try Gozd_V1_LoadAppStateResponse(jsonUTF8Data: loadResp)
    #expect(parsed.state.lastOpenedDir == "/foo/bar")
  }

  @Test("/fs/readFile は dir / path から bytes を返す")
  func fsReadFile() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let target = (dir as NSString).appendingPathComponent("a.txt")
    try "hello".write(toFile: target, atomically: true, encoding: .utf8)

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var req = Gozd_V1_FsReadFileRequest()
    req.dir = dir
    req.path = "a.txt"
    let respData = try await dispatcher.dispatch(path: "/fs/readFile", body: req.jsonUTF8Data())
    let resp = try Gozd_V1_FsReadFileResponse(jsonUTF8Data: respData)
    #expect(resp.content == "hello")
    #expect(resp.isBinary == false)
  }

  @Test("/pty/spawn → /pty/kill が ptyId 経由で完結する")
  func ptyLifecycle() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let exitFlag = ExitFlag()
    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in exitFlag.signal() }
    )

    var spawnReq = Gozd_V1_PtySpawnRequest()
    spawnReq.dir = "/tmp"
    spawnReq.executable = "/bin/cat"
    spawnReq.args = ["cat"]
    spawnReq.env = ProcessInfo.processInfo.environment
    spawnReq.rows = 24
    spawnReq.cols = 80
    let spawnResp = try Gozd_V1_PtySpawnResponse(
      jsonUTF8Data: try await dispatcher.dispatch(
        path: "/pty/spawn", body: spawnReq.jsonUTF8Data()))
    #expect(spawnResp.ptyID >= 1)

    var killReq = Gozd_V1_PtyKillRequest()
    killReq.ptyID = spawnResp.ptyID
    _ = try await dispatcher.dispatch(path: "/pty/kill", body: killReq.jsonUTF8Data())

    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if exitFlag.isSet { break }
      try await Task.sleep(for: .milliseconds(30))
    }
    #expect(exitFlag.isSet)
  }

  @Test("/claudeSession/removeByPty: expected resume sid 残留時に claude-sessions / tasks を片付ける (resume 失敗検出)")
  func removeByPtyResumeFailureCleanup() async throws {
    let configDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: configDir)) }
    let worktreeDir = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: worktreeDir)) }

    let dispatcher = RpcDispatcher(
      configDir: configDir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    // 既存の永続化を仕込む。dead sid X が claude-sessions.json / tasks.json に居る状態。
    let claudeSessions = ClaudeSessionStore(configDir: configDir)
    try await claudeSessions.upsert(worktreePath: worktreeDir, sessionId: "dead-X")
    let tasks = TaskStore(configDir: configDir)
    _ = try await tasks.add(
      dir: worktreeDir, body: "PR work", worktreeDir: worktreeDir,
      ghRef: .forPr(99))
    try await tasks.attachSession(
      dir: worktreeDir, sessionId: "dead-X", worktreeDir: worktreeDir)

    // PTY を spawn する。GOZD_RESUME_CLAUDE_SESSION で dead-X を渡し、SessionStart hook は
    // 一度も着弾させずに removeByPty する (= resume 失敗シナリオ)。
    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "dead-X"
    var spawnReq = Gozd_V1_PtySpawnRequest()
    spawnReq.dir = worktreeDir
    spawnReq.worktreePath = worktreeDir
    spawnReq.executable = "/bin/cat"
    spawnReq.args = ["cat"]
    spawnReq.env = env
    spawnReq.rows = 24
    spawnReq.cols = 80
    let spawnResp = try Gozd_V1_PtySpawnResponse(
      jsonUTF8Data: try await dispatcher.dispatch(
        path: "/pty/spawn", body: spawnReq.jsonUTF8Data()))

    var removeReq = Gozd_V1_ClaudeSessionRemoveByPtyRequest()
    removeReq.ptyID = spawnResp.ptyID
    removeReq.worktreePath = worktreeDir
    _ = try await dispatcher.dispatch(
      path: "/claudeSession/removeByPty", body: removeReq.jsonUTF8Data())

    // claude-sessions.json の dead-X は削除されている
    let remainingSessions = try await claudeSessions.savedSessions(for: worktreeDir)
    #expect(remainingSessions.isEmpty)
    // tasks.json の task は ghRef があるので残る + sessionId は空にクリアされる
    let remainingTasks = try await tasks.list(dir: worktreeDir)
    #expect(remainingTasks.count == 1)
    #expect(remainingTasks.first?.sessionID == "")
    #expect(remainingTasks.first?.ghRef.number == 99)

    var killReq = Gozd_V1_PtyKillRequest()
    killReq.ptyID = spawnResp.ptyID
    _ = try await dispatcher.dispatch(path: "/pty/kill", body: killReq.jsonUTF8Data())
  }

  @Test("/claudeSession/removeByPty: session-start 経由で dead expected が掃除された後でも live cleanup が正しく動く")
  func removeByPtyResumeFailurePlusLive() async throws {
    let configDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: configDir)) }
    let worktreeDir = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: worktreeDir)) }

    let dispatcher = RpcDispatcher(
      configDir: configDir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    // dead-X (resume 失敗の対象) と live-Y (resume 失敗後に zsh fallback で素 claude が
    // 発行する想定の新 sid) を両方の永続化に仕込む。session-start hook で live-Y を
    // 着弾させた時点で expected (dead-X) は消費 + cleanup されるが、その後の
    // removeByPty で残った live-Y を正しく片付けられることを確認する。
    let claudeSessions = ClaudeSessionStore(configDir: configDir)
    try await claudeSessions.upsert(worktreePath: worktreeDir, sessionId: "dead-X")
    try await claudeSessions.upsert(worktreePath: worktreeDir, sessionId: "live-Y")
    let tasks = TaskStore(configDir: configDir)
    _ = try await tasks.add(
      dir: worktreeDir, body: "PR work", worktreeDir: worktreeDir,
      ghRef: .forPr(99))
    try await tasks.attachSession(
      dir: worktreeDir, sessionId: "dead-X", worktreeDir: worktreeDir)
    // 新規 task を作って Y を attach (root wt 直接起動相当だが ghRef 無しで body 付き)
    _ = try await tasks.add(
      dir: worktreeDir, body: "scratch", worktreeDir: worktreeDir, ghRef: nil)
    try await tasks.attachSession(
      dir: worktreeDir, sessionId: "live-Y", worktreeDir: worktreeDir)

    // PTY spawn (expected=dead-X) → SessionStart hook で live-Y を載せる (resume 失敗後の
    // 素 claude 起動相当)。
    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "dead-X"
    var spawnReq = Gozd_V1_PtySpawnRequest()
    spawnReq.dir = worktreeDir
    spawnReq.worktreePath = worktreeDir
    spawnReq.executable = "/bin/cat"
    spawnReq.args = ["cat"]
    spawnReq.env = env
    spawnReq.rows = 24
    spawnReq.cols = 80
    let spawnResp = try Gozd_V1_PtySpawnResponse(
      jsonUTF8Data: try await dispatcher.dispatch(
        path: "/pty/spawn", body: spawnReq.jsonUTF8Data()))

    var hook = Gozd_V1_HookMessage()
    hook.event = "session-start"
    hook.ptyID = spawnResp.ptyID
    hook.sessionID = "live-Y"
    hook.source = "startup"
    var msg = Gozd_V1_ClientMessage()
    msg.body = .hook(hook)
    try await dispatcher.handleSocketMessage(try msg.jsonUTF8Data())

    var removeReq = Gozd_V1_ClaudeSessionRemoveByPtyRequest()
    removeReq.ptyID = spawnResp.ptyID
    removeReq.worktreePath = worktreeDir
    _ = try await dispatcher.dispatch(
      path: "/claudeSession/removeByPty", body: removeReq.jsonUTF8Data())

    // claude-sessions.json は X と Y 両方とも消える
    let remainingSessions = try await claudeSessions.savedSessions(for: worktreeDir)
    #expect(remainingSessions.isEmpty)
    // tasks: PR task (ghRef あり) は sid クリアで残る、scratch task (ghRef 無し) は削除
    let remainingTasks = try await tasks.list(dir: worktreeDir)
    #expect(remainingTasks.count == 1)
    let kept = try #require(remainingTasks.first)
    #expect(kept.body == "PR work")
    #expect(kept.ghRef.number == 99)
    #expect(kept.sessionID == "")

    var killReq = Gozd_V1_PtyKillRequest()
    killReq.ptyID = spawnResp.ptyID
    _ = try await dispatcher.dispatch(path: "/pty/kill", body: killReq.jsonUTF8Data())
  }

  @Test("session-start: expected と異なる sid で着弾したら dead expected を片付け、新 sid を同一 task に再 attach する (resume 失敗 + zsh fallback)")
  func sessionStartFallbackReattach() async throws {
    let configDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: configDir)) }
    let worktreeDir = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: worktreeDir)) }

    let dispatcher = RpcDispatcher(
      configDir: configDir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    // 既存の永続化を仕込む。dead sid X が claude-sessions.json と PR task に残っている状態。
    let claudeSessions = ClaudeSessionStore(configDir: configDir)
    try await claudeSessions.upsert(worktreePath: worktreeDir, sessionId: "dead-X")
    let tasks = TaskStore(configDir: configDir)
    let originalTask = try await tasks.add(
      dir: worktreeDir, body: "PR work", worktreeDir: worktreeDir,
      ghRef: .forPr(99))
    try await tasks.attachSession(
      dir: worktreeDir, sessionId: "dead-X", worktreeDir: worktreeDir)

    // PTY を spawn (expected=dead-X)。zsh fallback で素 claude が起動した想定で
    // SessionStart hook を sid=live-Y で着弾させる。
    var env = ProcessInfo.processInfo.environment
    env["GOZD_RESUME_CLAUDE_SESSION"] = "dead-X"
    var spawnReq = Gozd_V1_PtySpawnRequest()
    spawnReq.dir = worktreeDir
    spawnReq.worktreePath = worktreeDir
    spawnReq.executable = "/bin/cat"
    spawnReq.args = ["cat"]
    spawnReq.env = env
    spawnReq.rows = 24
    spawnReq.cols = 80
    let spawnResp = try Gozd_V1_PtySpawnResponse(
      jsonUTF8Data: try await dispatcher.dispatch(
        path: "/pty/spawn", body: spawnReq.jsonUTF8Data()))

    var hook = Gozd_V1_HookMessage()
    hook.event = "session-start"
    hook.ptyID = spawnResp.ptyID
    hook.sessionID = "live-Y"
    hook.source = "startup"
    var msg = Gozd_V1_ClientMessage()
    msg.body = .hook(hook)
    try await dispatcher.handleSocketMessage(try msg.jsonUTF8Data())

    // claude-sessions: dead-X は消え、live-Y のみ残る
    let sessions = try await claudeSessions.savedSessions(for: worktreeDir)
    #expect(sessions.count == 1)
    #expect(sessions.first?.sessionID == "live-Y")

    // tasks: 同一 task (originalTask.id) に sid=live-Y が再 attach されている (orphan 新規 task 作成なし)
    let remainingTasks = try await tasks.list(dir: worktreeDir)
    #expect(remainingTasks.count == 1)
    let reattached = try #require(remainingTasks.first)
    #expect(reattached.id == originalTask.id)
    #expect(reattached.body == "PR work")
    #expect(reattached.ghRef.number == 99)
    #expect(reattached.sessionID == "live-Y")

    var killReq = Gozd_V1_PtyKillRequest()
    killReq.ptyID = spawnResp.ptyID
    _ = try await dispatcher.dispatch(path: "/pty/kill", body: killReq.jsonUTF8Data())
  }

  @Test("/appConfig/save → /appConfig/load で round-trip")
  func appConfigRoundTrip() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var saveReq = Gozd_V1_SaveAppConfigRequest()
    var config = Gozd_V1_AppConfig()
    var terminal = Gozd_V1_TerminalConfig()
    terminal.theme = "Solarized Dark"
    terminal.fontFamily = "Menlo"
    terminal.fontSize = 14
    config.terminal = terminal
    saveReq.config = config
    _ = try await dispatcher.dispatch(path: "/appConfig/save", body: saveReq.jsonUTF8Data())

    let loadReq = Gozd_V1_LoadAppConfigRequest()
    let loadResp = try await dispatcher.dispatch(
      path: "/appConfig/load", body: loadReq.jsonUTF8Data())
    let parsed = try Gozd_V1_LoadAppConfigResponse(jsonUTF8Data: loadResp)
    #expect(parsed.config.terminal.theme == "Solarized Dark")
    #expect(parsed.config.terminal.fontFamily == "Menlo")
    #expect(parsed.config.terminal.fontSize == 14)
  }

  @Test("/appConfig/load はファイル不在で空 config を返す")
  func appConfigLoadDefault() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    let loadReq = Gozd_V1_LoadAppConfigRequest()
    let loadResp = try await dispatcher.dispatch(
      path: "/appConfig/load", body: loadReq.jsonUTF8Data())
    let parsed = try Gozd_V1_LoadAppConfigResponse(jsonUTF8Data: loadResp)
    #expect(parsed.config.terminal.theme == "")
    #expect(parsed.config.terminal.fontSize == 0)
  }

  @Test("/open/external は不正な URL で RpcError.invalidArgument を throw")
  func openExternalRejectsInvalidUrl() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var req = Gozd_V1_OpenExternalRequest()
    req.url = ""
    do {
      _ = try await dispatcher.dispatch(path: "/open/external", body: req.jsonUTF8Data())
      Issue.record("expected throw")
    } catch RpcError.invalidArgument {
      // OK
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("/open/external は file:// scheme を allowlist で reject する")
  func openExternalRejectsFileScheme() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    var req = Gozd_V1_OpenExternalRequest()
    req.url = "file:///tmp/x"
    do {
      _ = try await dispatcher.dispatch(path: "/open/external", body: req.jsonUTF8Data())
      Issue.record("expected throw")
    } catch RpcError.invalidArgument {
      // OK
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("openExternal allowlist: http / https / mailto は accept、それ以外は reject")
  func openExternalAllowlist() {
    // dispatch を経由せず純粋関数で判定をテストする（CI で NSWorkspace.open が走るのを避ける）
    let allowed = ["http://example.com", "https://example.com", "mailto:foo@example.com"]
    let rejected = ["file:///tmp/x", "javascript:alert(1)", "ssh://host", ""]

    for s in allowed {
      let url = URL(string: s)!
      #expect(RpcDispatcher.isOpenExternalSchemeAllowed(url), "expected allowed: \(s)")
    }
    for s in rejected {
      guard let url = URL(string: s) else { continue }
      #expect(!RpcDispatcher.isOpenExternalSchemeAllowed(url), "expected rejected: \(s)")
    }
  }

  @Test("未知の path は RpcError.unknownPath をスローする")
  func unknownPath() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    do {
      _ = try await dispatcher.dispatch(path: "/nonsense", body: Data())
      Issue.record("expected throw")
    } catch RpcError.unknownPath(let p) {
      #expect(p == "/nonsense")
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("handleSocketMessage は HookMessage を decode して onHook に渡す")
  func socketHookMessage() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let captured = HookCapture()
    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in },
      onHook: { hook in captured.set(hook) },
      onOpen: { _ in }
    )

    let line = Data(#"{"hook":{"event":"session-start","ptyId":42}}"#.utf8)
    try await dispatcher.handleSocketMessage(line)

    let h = captured.value
    #expect(h?.event == "session-start")
    #expect(h?.ptyID == 42)
  }

  @Test("handleSocketMessage は OpenMessage を decode して onOpen に渡す")
  func socketOpenMessage() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let captured = OpenCapture()
    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in },
      onHook: { _ in },
      onOpen: { path in captured.set(path) }
    )

    let line = Data(#"{"open":{"targetPath":"/Users/me/repo"}}"#.utf8)
    try await dispatcher.handleSocketMessage(line)

    #expect(captured.value == "/Users/me/repo")
  }

  @Test("handleSocketMessage は oneof 未指定で SocketDecodeError.emptyOneof を throw")
  func socketEmptyOneof() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let dispatcher = RpcDispatcher(
      configDir: dir,
      onPtyText: { _, _ in },
      onPtyExit: { _, _ in }
    )

    let line = Data("{}".utf8)
    do {
      try await dispatcher.handleSocketMessage(line)
      Issue.record("expected throw")
    } catch SocketDecodeError.emptyOneof {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("RpcDispatcher./git/showCommitFile")
struct RpcDispatcherGitShowCommitFileTests {
  @Test("単一コミット: from=<hash>^, to=<hash>, modified ファイルは unchanged=false")
  func singleCommitModified() async throws {
    let repo = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: repo)) }
    try "v1".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "init"], cwd: repo)
    try "v2".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "mod"], cwd: repo)
    let head = try await readGitForRpc(args: ["rev-parse", "HEAD"], cwd: repo)

    let resp = try await dispatchShowCommitFile(
      configDir: repo, dir: repo, relPath: "a.txt", hash: head, compareHash: "")
    #expect(resp.from.notFound == false)
    #expect(resp.from.content == "v1")
    #expect(resp.to.notFound == false)
    #expect(resp.to.content == "v2")
    #expect(resp.unchanged == false)
  }

  @Test("root commit: from は notFound (<hash>^ 解決失敗), to は内容を返す")
  func rootCommit() async throws {
    let repo = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: repo)) }
    try "only".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "init"], cwd: repo)
    let head = try await readGitForRpc(args: ["rev-parse", "HEAD"], cwd: repo)

    let resp = try await dispatchShowCommitFile(
      configDir: repo, dir: repo, relPath: "a.txt", hash: head, compareHash: "")
    #expect(resp.from.notFound == true)
    #expect(resp.to.notFound == false)
    #expect(resp.to.content == "only")
    #expect(resp.unchanged == false)
  }

  @Test("範囲選択: 範囲内で変更されていないファイルは unchanged=true、変更されていれば unchanged=false")
  func rangeUnchangedFile() async throws {
    let repo = try await makeGitRepoForRpc()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: repo)) }
    // <older>^ vs <newer> で older が root だと `^` 解決失敗するため、
    // older の前に seed commit を置いて 3 commit 構成にする。
    try "v0".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try "kept".write(
      toFile: (repo as NSString).appendingPathComponent("b.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt", "b.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "seed"], cwd: repo)
    try "v1".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "mod a v1"], cwd: repo)
    let older = try await readGitForRpc(args: ["rev-parse", "HEAD"], cwd: repo)
    try "v2".write(
      toFile: (repo as NSString).appendingPathComponent("a.txt"),
      atomically: true, encoding: .utf8)
    try await runGitForRpc(args: ["add", "a.txt"], cwd: repo)
    try await runGitForRpc(args: ["commit", "-m", "mod a v2"], cwd: repo)
    let newer = try await readGitForRpc(args: ["rev-parse", "HEAD"], cwd: repo)

    // b.txt は <older>^ = seed と <newer> どちらでも OID 同一 → unchanged=true
    let respB = try await dispatchShowCommitFile(
      configDir: repo, dir: repo, relPath: "b.txt", hash: newer, compareHash: older)
    #expect(respB.unchanged == true)

    // a.txt は範囲内で変更されている → unchanged=false。
    // from = <older>^ = seed の a.txt = "v0", to = newer の a.txt = "v2"
    let respA = try await dispatchShowCommitFile(
      configDir: repo, dir: repo, relPath: "a.txt", hash: newer, compareHash: older)
    #expect(respA.unchanged == false)
    #expect(respA.from.content == "v0")
    #expect(respA.to.content == "v2")
  }
}

// MARK: - showCommitFile test helpers

private func dispatchShowCommitFile(
  configDir: String, dir: String, relPath: String, hash: String, compareHash: String
) async throws -> Gozd_V1_GitShowCommitFileResponse {
  let dispatcher = RpcDispatcher(
    configDir: configDir,
    onPtyText: { _, _ in },
    onPtyExit: { _, _ in }
  )
  var req = Gozd_V1_GitShowCommitFileRequest()
  req.dir = dir
  req.relPath = relPath
  req.hash = hash
  req.compareHash = compareHash
  let respData = try await dispatcher.dispatch(
    path: "/git/showCommitFile", body: try req.jsonUTF8Data())
  return try Gozd_V1_GitShowCommitFileResponse(jsonUTF8Data: respData)
}

private func makeGitRepoForRpc() async throws -> String {
  let dir = try makeTempDir()
  try await runGitForRpc(args: ["init", "-q", "-b", "main"], cwd: dir)
  try await runGitForRpc(args: ["config", "user.name", "Test"], cwd: dir)
  try await runGitForRpc(args: ["config", "user.email", "test@example.com"], cwd: dir)
  return dir
}

private func runGitForRpc(args: [String], cwd: String) async throws {
  _ = try await readGitForRpc(args: args, cwd: cwd)
}

private func readGitForRpc(args: [String], cwd: String) async throws -> String {
  try await withCheckedThrowingContinuation {
    (cont: CheckedContinuation<String, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    process.environment = ProcessInfo.processInfo.environment
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    process.terminationHandler = { proc in
      let outData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      let errData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      if proc.terminationStatus == 0 {
        let text = String(decoding: outData, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        cont.resume(returning: text)
      } else {
        cont.resume(
          throwing: NSError(
            domain: "GitForRpc", code: Int(proc.terminationStatus),
            userInfo: [NSLocalizedDescriptionKey: String(decoding: errData, as: UTF8.self)]))
      }
    }
    do {
      try process.run()
    } catch {
      cont.resume(throwing: error)
    }
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-rpc-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}

private final class ExitFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var flag = false
  func signal() {
    lock.lock()
    defer { lock.unlock() }
    flag = true
  }
  var isSet: Bool {
    lock.lock()
    defer { lock.unlock() }
    return flag
  }
}

private final class HookCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Gozd_V1_HookMessage?
  func set(_ h: Gozd_V1_HookMessage) {
    lock.lock()
    defer { lock.unlock() }
    stored = h
  }
  var value: Gozd_V1_HookMessage? {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }
}

private final class OpenCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: String?
  func set(_ s: String) {
    lock.lock()
    defer { lock.unlock() }
    stored = s
  }
  var value: String? {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }
}
