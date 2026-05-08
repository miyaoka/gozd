import Foundation

// ファイルシステム操作 RPC のロジック層。
//
// 設計判断:
//
// 1. **path は dir からの相対パス**として扱う。絶対パスや `..` を経由した
//    dir 範囲外アクセスは拒否する（path traversal 対策）。
//
// 2. **判定は realpath ベース**: `URL.resolvingSymlinksInPath()` で symlink を
//    解決した実パスで `dir` 配下にあるかを判定する。文字列 prefix 判定だけだと
//    `/foo/bar` が `/foo/barbaz` の prefix になる罠を踏むので
//    `targetPath == dirPath || targetPath.hasPrefix(dirPath + "/")` で照合。
//
// 3. **戻り値は素の Swift 型**（`Data` / `[FSEntry]`）。proto 型変換は RPC 境界
//    （URLSchemeHandler）に閉じ込める。GitOps と同じ流儀。
public struct FileReadInfo: Sendable, Equatable {
  public let content: String
  public let isBinary: Bool
  public let isDirectory: Bool
  public let notFound: Bool
  public init(content: String, isBinary: Bool, isDirectory: Bool, notFound: Bool) {
    self.content = content
    self.isBinary = isBinary
    self.isDirectory = isDirectory
    self.notFound = notFound
  }

  public static let notFoundResult = FileReadInfo(
    content: "", isBinary: false, isDirectory: false, notFound: true)
  public static let directoryResult = FileReadInfo(
    content: "", isBinary: false, isDirectory: true, notFound: false)
}

public enum FSOps {
  /// FileReadResult ベースで読み取る。NUL byte を含む or UTF-8 decode 失敗で is_binary=true。
  public static func readFile(dir: String, path: String) throws -> FileReadInfo {
    let target = try resolveSafe(dir: dir, path: path)
    return readFileAt(absolutePath: target)
  }

  /// 絶対パスでファイルを読み取る（dir 制約なし）。プレビューで dir 外参照が必要なため。
  public static func readFileAbsolute(absolutePath: String) -> FileReadInfo {
    return readFileAt(absolutePath: absolutePath)
  }

  /// FsReadFileResponse 用に Data 単独でも返せるよう保持しているレガシー API。
  public static func readFileBytes(dir: String, path: String) throws -> Data {
    let target = try resolveSafe(dir: dir, path: path)
    return try Data(contentsOf: URL(fileURLWithPath: target))
  }

  public static func writeFile(dir: String, path: String, data: Data) throws {
    let target = try resolveSafe(dir: dir, path: path)
    let parentDir = (target as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: parentDir, withIntermediateDirectories: true)
    try data.write(to: URL(fileURLWithPath: target))
  }

  public static func stat(dir: String, path: String) throws -> FSStatResult {
    let target = try resolveSafe(dir: dir, path: path)
    var isDir: ObjCBool = false
    let exists = FileManager.default.fileExists(atPath: target, isDirectory: &isDir)
    if !exists {
      return FSStatResult(exists: false, type: "", size: 0, modifiedAt: "")
    }
    let attrs = try FileManager.default.attributesOfItem(atPath: target)
    let size = (attrs[.size] as? UInt64) ?? 0
    let modDate = (attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
    let type: String
    if let fileType = attrs[.type] as? FileAttributeType, fileType == .typeSymbolicLink {
      type = "symlink"
    } else if isDir.boolValue {
      type = "directory"
    } else {
      type = "file"
    }
    return FSStatResult(
      exists: true, type: type, size: size,
      modifiedAt: ISO8601DateFormatter().string(from: modDate))
  }

  public static func readDir(dir: String, path: String) async throws -> [FSEntry] {
    let target = try resolveSafe(dir: dir, path: path)
    let url = URL(fileURLWithPath: target)
    let entries = try FileManager.default.contentsOfDirectory(
      at: url,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
      options: []
    )
    let listed: [(URL, String)] = entries.map { entry in
      let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      let type: String
      if values?.isSymbolicLink == true {
        type = "symlink"
      } else if values?.isDirectory == true {
        type = "directory"
      } else {
        type = "file"
      }
      return (entry, type)
    }
    // gitignore 判定は dir（worktree root）からの相対パスで行う。
    // path が空なら entry name そのまま、サブディレクトリなら "<path>/<name>"。
    let prefix = path.isEmpty ? "" : (path.hasSuffix("/") ? path : path + "/")
    let relPaths = listed.map { prefix + $0.0.lastPathComponent }
    let ignored = await GitOps.checkIgnore(dir: dir, relPaths: relPaths)
    return listed
      .map { (entry, type) -> FSEntry in
        let rel = prefix + entry.lastPathComponent
        return FSEntry(
          name: entry.lastPathComponent, type: type, isIgnored: ignored.contains(rel))
      }
      .sorted { $0.name < $1.name }
  }
}

/// 共通の file 読み取り処理。directory / not-found / binary 検出を一括で扱う。
private func readFileAt(absolutePath: String) -> FileReadInfo {
  var isDir: ObjCBool = false
  let exists = FileManager.default.fileExists(atPath: absolutePath, isDirectory: &isDir)
  if !exists { return .notFoundResult }
  if isDir.boolValue { return .directoryResult }
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: absolutePath)) else {
    return .notFoundResult
  }
  // NUL byte を含む or UTF-8 decode 失敗で binary 判定。
  if data.contains(0x00) {
    return FileReadInfo(content: "", isBinary: true, isDirectory: false, notFound: false)
  }
  guard let text = String(data: data, encoding: .utf8) else {
    return FileReadInfo(content: "", isBinary: true, isDirectory: false, notFound: false)
  }
  return FileReadInfo(content: text, isBinary: false, isDirectory: false, notFound: false)
}

public struct FSEntry: Sendable, Equatable {
  public let name: String
  public let type: String
  public let isIgnored: Bool
  public init(name: String, type: String, isIgnored: Bool = false) {
    self.name = name
    self.type = type
    self.isIgnored = isIgnored
  }
}

public struct FSStatResult: Sendable, Equatable {
  public let exists: Bool
  public let type: String
  public let size: UInt64
  public let modifiedAt: String
}

public enum FSError: Error, Equatable {
  case outsideDir(requestedPath: String)
}

// MARK: - private helpers

private func resolveSafe(dir: String, path: String) throws -> String {
  let dirURL = URL(fileURLWithPath: dir).resolvingSymlinksInPath()
  let targetURL = URL(fileURLWithPath: path, relativeTo: dirURL).resolvingSymlinksInPath()
  let dirPath = dirURL.path
  let targetPath = targetURL.path
  // /foo が /foobar の prefix になる罠を避けるため separator まで照合する。
  if targetPath == dirPath || targetPath.hasPrefix(dirPath + "/") {
    return targetPath
  }
  throw FSError.outsideDir(requestedPath: path)
}
