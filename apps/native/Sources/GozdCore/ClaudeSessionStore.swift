import Foundation
import GozdProto

// Claude Code セッションの永続化（`~/.config/gozd/projects/<projectKey>/claude-sessions.json`）。
//
// 設計判断:
//
// 1. **プロジェクト粒度のファイル + worktreePath で内部分割**。worktreePath ごとに
//    独立ファイルにすると open / remove で worktree → ファイル名解決が必要になり面倒。
//    1 プロジェクト 1 ファイルにして、worktreePath で filter する。
//
// 2. **session-end は session_id をキーに削除**。ptyId は揮発で再起動を跨がないため、
//    永続化キーには使えない。session_id は Claude が生成する UUID で安定。
//
// 3. **resume 時に存在チェック**。アプリクラッシュで session-end が来なかった
//    残骸エントリは、起動時に transcript ファイルの存在を確認して落とす（呼び出し側責任）。
//
// 4. **actor**。複数 hook が並行で書きにくる可能性があるためファイル破損を防ぐ。
public actor ClaudeSessionStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  /// session-start hook 受信時に呼ぶ。同 sessionId の既存エントリは置き換える。
  public func upsert(
    worktreePath: String, sessionId: String, transcriptPath: String
  ) throws {
    var list = try loadFile(for: worktreePath)
    list.sessions.removeAll { $0.sessionID == sessionId }
    var entry = Gozd_V1_ClaudeSession()
    entry.worktreePath = worktreePath
    entry.sessionID = sessionId
    entry.transcriptPath = transcriptPath
    entry.updatedAt = ISO8601DateFormatter().string(from: Date())
    list.sessions.append(entry)
    try saveFile(list, for: worktreePath)
  }

  /// session-end hook 受信時に呼ぶ。
  public func removeBySessionId(worktreePath: String, sessionId: String) throws {
    var list = try loadFile(for: worktreePath)
    let before = list.sessions.count
    list.sessions.removeAll { $0.sessionID == sessionId }
    if list.sessions.count != before {
      try saveFile(list, for: worktreePath)
    }
  }

  /// renderer が worktree オープン時に呼ぶ。指定 dir に紐づくセッションのうち
  /// transcript ファイルが存在するものだけを返す（残骸を自動掃除して save し直す）。
  public func liveSessions(for dir: String) throws -> [Gozd_V1_ClaudeSession] {
    var list = try loadFile(for: dir)
    let live = list.sessions.filter { entry in
      entry.worktreePath == dir
        && FileManager.default.fileExists(atPath: entry.transcriptPath)
    }
    let dead = list.sessions.filter { entry in
      entry.worktreePath == dir
        && !FileManager.default.fileExists(atPath: entry.transcriptPath)
    }
    if !dead.isEmpty {
      list.sessions.removeAll { e in dead.contains { $0.sessionID == e.sessionID } }
      try saveFile(list, for: dir)
    }
    return live
  }

  /// worktree 削除時に該当 worktreePath のエントリを全削除。
  public func removeByWorktreePath(_ worktreePath: String) throws {
    var list = try loadFile(for: worktreePath)
    let before = list.sessions.count
    list.sessions.removeAll { $0.worktreePath == worktreePath }
    if list.sessions.count != before {
      try saveFile(list, for: worktreePath)
    }
  }

  // MARK: - paths

  private func filePath(for dir: String) -> String {
    let projectKey = ProjectKey.resolveAndCompute(for: dir)
    return (configDir as NSString)
      .appendingPathComponent("projects")
      .appending("/\(projectKey)/claude-sessions.json")
  }

  private func loadFile(for dir: String) throws -> Gozd_V1_ClaudeSessionList {
    let path = filePath(for: dir)
    if !FileManager.default.fileExists(atPath: path) {
      return Gozd_V1_ClaudeSessionList()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let json = String(decoding: data, as: UTF8.self)
    return (try? Gozd_V1_ClaudeSessionList(jsonString: json))
      ?? Gozd_V1_ClaudeSessionList()
  }

  private func saveFile(_ list: Gozd_V1_ClaudeSessionList, for dir: String) throws {
    let path = filePath(for: dir)
    let parentDir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: parentDir, withIntermediateDirectories: true)
    let json = try list.jsonString()
    try json.write(toFile: path, atomically: true, encoding: .utf8)
  }
}
