import Foundation
import GozdProto

// FS 系 RPC handler。`FSOps` (file IO) と `FSWatchRegistry` (FSEvents 監視) への薄いラッパー。

extension RpcDispatcher {
  func handleFsReadFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileRequest(jsonUTF8Data: body)
    let info = try FSOps.readFile(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadFileResponse()
    resp.content = info.content
    resp.isBinary = info.isBinary
    resp.isDirectory = info.isDirectory
    resp.notFound = info.notFound
    return try resp.jsonUTF8Data()
  }

  func handleFsReadDir(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsReadDirRequest(jsonUTF8Data: body)
    let result = try await FSOps.readDir(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadDirResponse()
    resp.notFound = result.notFound
    resp.entries = result.entries.map { entry in
      var e = Gozd_V1_FsReadDirEntry()
      e.name = entry.name
      e.type = entry.type
      e.isIgnored = entry.isIgnored
      return e
    }
    return try resp.jsonUTF8Data()
  }

  func handleFsWatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsWatchRequest(jsonUTF8Data: body)
    try await fsWatch.watch(dir: req.dir)
    return try Gozd_V1_FsWatchResponse().jsonUTF8Data()
  }

  func handleFsUnwatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsUnwatchRequest(jsonUTF8Data: body)
    await fsWatch.unwatch(dir: req.dir)
    return try Gozd_V1_FsUnwatchResponse().jsonUTF8Data()
  }

  func handleFsUnwatchAll(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_FsUnwatchAllRequest(jsonUTF8Data: body)
    let count = await fsWatch.unwatchAll()
    var resp = Gozd_V1_FsUnwatchAllResponse()
    resp.unwatchedCount = UInt32(count)
    return try resp.jsonUTF8Data()
  }

  func handleFsReadFileAbsolute(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileAbsoluteRequest(jsonUTF8Data: body)
    let info = FSOps.readFileAbsolute(absolutePath: req.absolutePath)
    var resp = Gozd_V1_FsReadFileAbsoluteResponse()
    var fr = Gozd_V1_FileReadResult()
    fr.content = info.content
    fr.isBinary = info.isBinary
    fr.isDirectory = info.isDirectory
    fr.notFound = info.notFound
    resp.result = fr
    return try resp.jsonUTF8Data()
  }

  func handleFsWriteFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsWriteFileRequest(jsonUTF8Data: body)
    try FSOps.writeFile(dir: req.dir, path: req.path, data: req.data)
    return try Gozd_V1_FsWriteFileResponse().jsonUTF8Data()
  }

  func handleFsStat(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsStatRequest(jsonUTF8Data: body)
    let stat = try FSOps.stat(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsStatResponse()
    resp.exists = stat.exists
    resp.type = stat.type
    resp.size = stat.size
    resp.modifiedAt = stat.modifiedAt
    return try resp.jsonUTF8Data()
  }
}
