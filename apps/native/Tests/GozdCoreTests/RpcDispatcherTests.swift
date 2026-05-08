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
