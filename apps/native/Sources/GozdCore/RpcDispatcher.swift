import Foundation
import GozdProto

// gozd-rpc:// URLSchemeHandler から呼ばれる RPC dispatcher。
//
// 設計判断:
//
// 1. **actor**。PTYRegistry / AppStateStore など共有状態を内包し、
//    複数の URL リクエストが並行してくる WebKit 側からの呼び出しを serial に処理する。
//
// 2. **path 階層**: `/echo` / `/git/status` / `/fs/readFile` / `/pty/spawn` 等。
//    URL でグルーピングが視認しやすい。
//
// 3. **PTY イベントの WebPage push は dispatcher の責務外**。onPtyData / onPtyExit を
//    init で受け取り、PTYRegistry にそのまま渡す。WebPage への callJavaScript wire-up は
//    Phase 3（URLSchemeHandler 統合段階）で URLSchemeHandler 側が実装する。
//
// 4. **戻り値は proto JSON Data**。失敗は throw。URLSchemeHandler 側が HTTP 200 / 4xx / 5xx と
//    `Access-Control-Allow-Origin: *` ヘッダを付ける。
public actor RpcDispatcher {
  private let pty: PTYRegistry
  private let appState: AppStateStore

  public init(
    configDir: String,
    onPtyData: @escaping @Sendable (UInt32, Data) -> Void,
    onPtyExit: @escaping @Sendable (UInt32, PTYExitReason) -> Void
  ) {
    self.pty = PTYRegistry(onData: onPtyData, onExit: onPtyExit)
    self.appState = AppStateStore(configDir: configDir)
  }

  public func dispatch(path: String, body: Data) async throws -> Data {
    switch path {
    case "/echo":
      return try await handleEcho(body)
    case "/git/status":
      return try await handleGitStatus(body)
    case "/fs/readFile":
      return try handleFsReadFile(body)
    case "/fs/readDir":
      return try handleFsReadDir(body)
    case "/pty/spawn":
      return try await handlePtySpawn(body)
    case "/pty/write":
      return try await handlePtyWrite(body)
    case "/pty/resize":
      return try await handlePtyResize(body)
    case "/pty/kill":
      return try await handlePtyKill(body)
    case "/appState/load":
      return try handleLoadAppState(body)
    case "/appState/save":
      return try handleSaveAppState(body)
    default:
      throw RpcError.unknownPath(path)
    }
  }

  // MARK: - handlers

  private func handleEcho(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_EchoRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_EchoResponse()
    resp.text = "echo: \(req.text)"
    return try resp.jsonUTF8Data()
  }

  private func handleGitStatus(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitStatusRequest(jsonUTF8Data: body)
    let entries = try await GitOps.gitStatus(dir: req.dir)
    var resp = Gozd_V1_GitStatusResponse()
    resp.entries = entries
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileRequest(jsonUTF8Data: body)
    let data = try FSOps.readFile(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadFileResponse()
    resp.data = data
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadDir(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadDirRequest(jsonUTF8Data: body)
    let entries = try FSOps.readDir(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadDirResponse()
    resp.entries = entries.map { entry in
      var e = Gozd_V1_FsReadDirEntry()
      e.name = entry.name
      e.type = entry.type
      return e
    }
    return try resp.jsonUTF8Data()
  }

  private func handlePtySpawn(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtySpawnRequest(jsonUTF8Data: body)
    let id = try await pty.spawn(
      executable: req.executable,
      args: req.args,
      env: req.env,
      cwd: req.dir,
      rows: UInt16(req.rows),
      cols: UInt16(req.cols)
    )
    var resp = Gozd_V1_PtySpawnResponse()
    resp.ptyID = id
    return try resp.jsonUTF8Data()
  }

  private func handlePtyWrite(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyWriteRequest(jsonUTF8Data: body)
    await pty.write(id: req.ptyID, data: req.data)
    return try Gozd_V1_PtyWriteResponse().jsonUTF8Data()
  }

  private func handlePtyResize(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyResizeRequest(jsonUTF8Data: body)
    await pty.resize(id: req.ptyID, rows: UInt16(req.rows), cols: UInt16(req.cols))
    return try Gozd_V1_PtyResizeResponse().jsonUTF8Data()
  }

  private func handlePtyKill(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyKillRequest(jsonUTF8Data: body)
    await pty.kill(id: req.ptyID)
    return try Gozd_V1_PtyKillResponse().jsonUTF8Data()
  }

  private func handleLoadAppState(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppStateRequest(jsonUTF8Data: body)
    let state = try appState.load()
    var resp = Gozd_V1_LoadAppStateResponse()
    resp.state = state
    return try resp.jsonUTF8Data()
  }

  private func handleSaveAppState(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppStateRequest(jsonUTF8Data: body)
    try appState.save(req.state)
    return try Gozd_V1_SaveAppStateResponse().jsonUTF8Data()
  }
}

public enum RpcError: Error, Equatable {
  case unknownPath(String)
}
