import Foundation
import GozdProto

// PTY 系 RPC handler。`PTYRegistry` への薄いラッパー + spawn 失敗時の observable な stderr log。

extension RpcDispatcher {
  func handlePtySpawn(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtySpawnRequest(jsonUTF8Data: body)
    let id: UInt32
    do {
      id = try await pty.spawn(
        executable: req.executable,
        args: req.args,
        env: req.env,
        cwd: req.dir,
        rows: UInt16(req.rows),
        cols: UInt16(req.cols),
        worktreePath: req.worktreePath
      )
    } catch let error as PTYError {
      // `RpcSchemeHandler` の包括 catch (`GozdApp.swift` 内 `RpcSchemeHandler.reply`)
      // は 500 response の body に文字列を載せるだけで stderr には書き出さない。
      // よって本 handler 側で stderr に書かなければ Console.app には spawn 失敗の
      // 痕跡が残らない。PTYError のサブ case（openptyFailed / forkFailed /
      // preforkAllocFailed）に加え、再現に必要な executable / cwd / worktreePath を
      // 併記する。worktreePath は cwd と独立で、複数 worktree が並列に Claude を
      // 起動する gozd の primary use case で「どの worktree の spawn か」を識別する
      // ために必要（cwd はユーザーが任意に cd した path で worktree とは限らない）。
      StderrLog.write(
        tag: "handlePtySpawn",
        "pty.spawn failed: \(error) executable=\(req.executable) cwd=\(req.dir) worktreePath=\(req.worktreePath)"
      )
      throw error
    }
    var resp = Gozd_V1_PtySpawnResponse()
    resp.ptyID = id
    return try resp.jsonUTF8Data()
  }

  func handlePtyWrite(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyWriteRequest(jsonUTF8Data: body)
    await pty.write(id: req.ptyID, data: req.data)
    return try Gozd_V1_PtyWriteResponse().jsonUTF8Data()
  }

  func handlePtyResize(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyResizeRequest(jsonUTF8Data: body)
    await pty.resize(id: req.ptyID, rows: UInt16(req.rows), cols: UInt16(req.cols))
    return try Gozd_V1_PtyResizeResponse().jsonUTF8Data()
  }

  func handlePtyKill(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyKillRequest(jsonUTF8Data: body)
    await pty.kill(id: req.ptyID)
    return try Gozd_V1_PtyKillResponse().jsonUTF8Data()
  }
}
