import Foundation

// ファイルシステム操作 RPC のロジック層。
//
// 設計判断:
//
// 1. **path は dir からの相対パス**として扱う。絶対パスや `..` を経由した
//    dir 範囲外アクセスは拒否する（path traversal 対策）。
//
// 2. **判定は `resolveContained` (FilePath.lexicallyResolving) に委譲**: path
//    containment の SSOT は `PathContainment.swift`。Apple 公式 API で絶対パス注入 /
//    `..` 脱出 / prefix 罠を構造的に防ぐ。FS 非依存なので削除済み dir でも決定的に動く。
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

  /// 絶対パスで raw bytes を読み取る（dir 制約なし）。preview の worktree 外画像 / SVG 用。
  /// テキスト経路の `readFileAbsolute` と揃えているのは「dir 外参照を許す」参照範囲の契約のみ。
  /// 戻り方は別で、不在 / ディレクトリは throw し handler が 500 → `<img>` error に倒す
  /// （notFound / directory の正常応答への畳み込みはテキスト経路 `readFileAt` が担う）。
  public static func readFileBytesAbsolute(absolutePath: String) throws -> Data {
    return try Data(contentsOf: URL(fileURLWithPath: absolutePath))
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

  public static func readDir(dir: String, path: String) async throws -> FSReadDirResult {
    let target = try resolveSafe(dir: dir, path: path)
    let url = URL(fileURLWithPath: target)
    let rawEntries: [URL]
    do {
      rawEntries = try FileManager.default.contentsOfDirectory(
        at: url,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
        options: []
      )
    } catch {
      // 列挙に失敗。対象がディレクトリとして存在するか「失敗後」に再確認する。
      // 不在 (ENOENT) / ディレクトリでなくなった (ENOTDIR: 削除後に同名ファイルへ置換) なら
      // 削除済みノードとして notFound を返す。展開中ノードの削除・置換は watcher 経由で
      // readDir を走らせるため、これらは期待状態であり 500 にしない (readFile の notFound と
      // 同じ規律)。事前 fileExists ではなく失敗後 recheck にすることで、存在チェックと列挙の
      // 隙に削除される TOCTOU race を避ける。存在するディレクトリでの失敗 (permission 等) は
      // 真の読み取りエラーなので rethrow して 500 にする。
      var isDir: ObjCBool = false
      let exists = FileManager.default.fileExists(atPath: target, isDirectory: &isDir)
      if !exists || !isDir.boolValue {
        return FSReadDirResult(entries: [], notFound: true)
      }
      throw error
    }
    // `.git` (directory / gitlink file 両方) はツリーから完全一致で除外する。
    // 仕様契約は docs/filer.md「除外エントリ」を参照。
    // gitignore 経路とは独立。checkIgnore に渡す前に落とし、無駄な git 呼び出しも省く。
    let entries = rawEntries.filter { $0.lastPathComponent != ".git" }
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
    let fsEntries =
      listed
      .map { (entry, type) -> FSEntry in
        let rel = prefix + entry.lastPathComponent
        return FSEntry(
          name: entry.lastPathComponent, type: type, isIgnored: ignored.contains(rel))
      }
      .sorted { $0.name < $1.name }
    return FSReadDirResult(entries: fsEntries, notFound: false)
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

public struct FSReadDirResult: Sendable, Equatable {
  public let entries: [FSEntry]
  /// ディレクトリ不在（削除済み等）。読み取りエラーとは区別し、正常応答として返す。
  public let notFound: Bool
  public init(entries: [FSEntry], notFound: Bool) {
    self.entries = entries
    self.notFound = notFound
  }
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
  guard let resolved = resolveContained(base: dir, subpath: path) else {
    throw FSError.outsideDir(requestedPath: path)
  }
  return resolved
}
