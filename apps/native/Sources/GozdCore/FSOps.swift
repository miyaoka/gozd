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
public enum FSOps {
  public static func readFile(dir: String, path: String) throws -> Data {
    let target = try resolveSafe(dir: dir, path: path)
    return try Data(contentsOf: URL(fileURLWithPath: target))
  }

  public static func readDir(dir: String, path: String) throws -> [FSEntry] {
    let target = try resolveSafe(dir: dir, path: path)
    let url = URL(fileURLWithPath: target)
    let entries = try FileManager.default.contentsOfDirectory(
      at: url,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
      options: []
    )
    return entries
      .map { entry -> FSEntry in
        let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        let type: String
        if values?.isSymbolicLink == true {
          type = "symlink"
        } else if values?.isDirectory == true {
          type = "directory"
        } else {
          type = "file"
        }
        return FSEntry(name: entry.lastPathComponent, type: type)
      }
      .sorted { $0.name < $1.name }
  }
}

public struct FSEntry: Sendable, Equatable {
  public let name: String
  public let type: String
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
