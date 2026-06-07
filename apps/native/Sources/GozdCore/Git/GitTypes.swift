import Foundation

// GitOps 周辺で renderer / RPC 層に渡す公開値型の集約。namespace `GitOps` への入れ子型
// (`LogResult` / `StatusFull` / `GitDirs`) は所属 op と一緒に各 `GitOps+Op.swift` 側に置く。

public struct WorktreeInfo: Equatable, Sendable {
  public let path: String
  public let head: String
  public let branch: String?
  public let isMain: Bool
  public init(path: String, head: String, branch: String?, isMain: Bool) {
    self.path = path
    self.head = head
    self.branch = branch
    self.isMain = isMain
  }
}

public struct CommitInfo: Equatable, Sendable {
  public let hash: String
  public let shortHash: String
  public let parents: [String]
  public let author: String
  public let date: Int64
  public let message: String
  public let body: String
  public let refs: [String]
  public init(
    hash: String, shortHash: String, parents: [String], author: String, date: Int64,
    message: String, body: String, refs: [String]
  ) {
    self.hash = hash
    self.shortHash = shortHash
    self.parents = parents
    self.author = author
    self.date = date
    self.message = message
    self.body = body
    self.refs = refs
  }
}

public struct FileChangeInfo: Equatable, Sendable {
  public let oldPath: String
  public let newPath: String
  public let type: String  // "A" / "M" / "D" / "R" / "U"
  public init(oldPath: String, newPath: String, type: String) {
    self.oldPath = oldPath
    self.newPath = newPath
    self.type = type
  }
}

public enum DiffHunkLineKind: Sendable {
  case context
  case added
  case removed
}

public struct DiffHunkLineInfo: Equatable, Sendable {
  public let kind: DiffHunkLineKind
  public let text: String
  public init(kind: DiffHunkLineKind, text: String) {
    self.kind = kind
    self.text = text
  }
}

public struct DiffHunkInfo: Equatable, Sendable {
  public let oldStart: UInt32
  public let oldLines: UInt32
  public let newStart: UInt32
  public let newLines: UInt32
  public let lines: [DiffHunkLineInfo]
  public init(
    oldStart: UInt32, oldLines: UInt32, newStart: UInt32, newLines: UInt32,
    lines: [DiffHunkLineInfo]
  ) {
    self.oldStart = oldStart
    self.oldLines = oldLines
    self.newStart = newStart
    self.newLines = newLines
    self.lines = lines
  }
}

public struct DiffHunksResult: Equatable, Sendable {
  public let hunks: [DiffHunkInfo]
  /// 入力 `original` の総行数 (git の line counting 規約に従う)。
  /// trailing バー / context 拡張の絶対座標計算の SSOT として renderer に返す。
  public let oldTotalLines: UInt32
  /// 入力 `current` の総行数 (git の line counting 規約に従う)。
  public let newTotalLines: UInt32
  public init(hunks: [DiffHunkInfo], oldTotalLines: UInt32, newTotalLines: UInt32) {
    self.hunks = hunks
    self.oldTotalLines = oldTotalLines
    self.newTotalLines = newTotalLines
  }
}

/// `git ls-tree -z <hash> <path>/` の 1 エントリ。
///
/// type は git mode → 文字列の写像で、SSOT は `typeFromGitMode`:
///   - 040000 → "directory"
///   - 120000 → "symlink"
///   - 160000 → "submodule"
///   - 100644 / 100755 / その他 → "file"
public struct GitTreeEntryInfo: Equatable, Sendable {
  public let name: String
  public let type: String
  public init(name: String, type: String) {
    self.name = name
    self.type = type
  }
}

/// 単一行の blame 結果。
public struct BlameLineInfo: Equatable, Sendable {
  public let hash: String
  public let shortHash: String
  public let author: String
  public let authorMail: String
  public let authorTime: Int64
  public let summary: String
  public let sourceLine: UInt32
  public let notCommitted: Bool
  public init(
    hash: String, shortHash: String, author: String, authorMail: String, authorTime: Int64,
    summary: String, sourceLine: UInt32, notCommitted: Bool
  ) {
    self.hash = hash
    self.shortHash = shortHash
    self.author = author
    self.authorMail = authorMail
    self.authorTime = authorTime
    self.summary = summary
    self.sourceLine = sourceLine
    self.notCommitted = notCommitted
  }
}
