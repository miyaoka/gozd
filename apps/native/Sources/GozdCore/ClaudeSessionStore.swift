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
// 3. **read は pure read**。`savedSessions` / `allSavedSessions` は保存されている
//    エントリをそのまま返す。proactive な transcript 存在チェックはしない (Claude 側
//    の transcript 保存仕様への依存を避けるため)。クラッシュ等で session-end が
//    走らず残った dead entry は、resume 試行時に `claude --resume` がエラー終了する
//    のを検知して削除する経路に倒す (RpcDispatcher の resume-failure 検出を参照)。
//
// 4. **actor**。複数 hook が並行で書きにくる可能性があるためファイル破損を防ぐ。
public actor ClaudeSessionStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  /// session-start hook 受信時に呼ぶ。同 sessionId の既存エントリは置き換える。
  public func upsert(worktreePath: String, sessionId: String) throws {
    var list = try loadFile(for: worktreePath)
    list.sessions.removeAll { $0.sessionID == sessionId }
    var entry = Gozd_V1_ClaudeSession()
    entry.worktreePath = worktreePath
    entry.sessionID = sessionId
    entry.updatedAt = ISO8601DateFormatter().string(from: Date())
    list.sessions.append(entry)
    try saveFile(list, for: worktreePath)
  }

  /// session-end hook / resume 失敗検出時に呼ぶ。
  public func removeBySessionId(worktreePath: String, sessionId: String) throws {
    var list = try loadFile(for: worktreePath)
    let before = list.sessions.count
    list.sessions.removeAll { $0.sessionID == sessionId }
    if list.sessions.count != before {
      try saveFile(list, for: worktreePath)
    }
  }

  /// 指定 dir に紐づく保存セッションを返す (pure read)。
  /// renderer の visit() が「未訪問 worktree 初回オープン時の resume 復元」で使う。
  /// dead entry が含まれ得るが、その場合 `claude --resume` がエラー終了し、resume
  /// 失敗検出経路で当該エントリを削除する。
  public func savedSessions(for dir: String) throws -> [Gozd_V1_ClaudeSession] {
    let list = try loadFile(for: dir)
    return list.sessions.filter { $0.worktreePath == dir }
  }

  /// プロジェクト全体の保存セッションを返す (worktree 横断、pure read)。
  /// サイドバーが「各 worktree が何個 resume 可能か」をバッジ表示するための一括取得。
  public func allSavedSessions(forProject dir: String) throws -> [Gozd_V1_ClaudeSession] {
    let list = try loadFile(for: dir)
    return list.sessions
  }

  /// worktree 削除時に該当 worktreePath のエントリを全削除。
  /// projectKey 解決は `projectAnchorDir`（main repo dir 等、削除されない dir）から行う。
  /// `worktreePath` をそのまま使うと、すでに物理削除された path に対する
  /// `git rev-parse --git-common-dir` が失敗して projectKey が前回と変わり、
  /// 別ファイルを read/write してエントリが残留する。
  public func removeByWorktreePath(
    projectAnchorDir: String, worktreePath: String
  ) throws {
    var list = try loadFile(for: projectAnchorDir)
    let before = list.sessions.count
    list.sessions.removeAll { $0.worktreePath == worktreePath }
    if list.sessions.count != before {
      try saveFile(list, for: projectAnchorDir)
    }
  }

  // MARK: - paths

  private func fileURL(for dir: String) -> URL {
    let projectKey = ProjectKey.resolveAndCompute(for: dir)
    return URL(fileURLWithPath: configDir)
      .appendingPathComponent("projects")
      .appendingPathComponent(projectKey)
      .appendingPathComponent("claude-sessions.json")
  }

  private func loadFile(for dir: String) throws -> Gozd_V1_ClaudeSessionList {
    let url = fileURL(for: dir)
    if !FileManager.default.fileExists(atPath: url.path) {
      return Gozd_V1_ClaudeSessionList()
    }
    let data = try Data(contentsOf: url)
    if let json = String(bytes: data, encoding: .utf8) {
      do {
        return try Gozd_V1_ClaudeSessionList(jsonString: json)
      } catch {
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] loadFile: parse failed at \(url.path): \(error)\n"
              .utf8))
      }
    } else {
      FileHandle.standardError.write(
        Data("[ClaudeSessionStore] loadFile: invalid UTF-8 at \(url.path)\n".utf8))
    }
    let empty = Gozd_V1_ClaudeSessionList()
    try saveFile(empty, for: dir)
    FileHandle.standardError.write(
      Data(
        "[ClaudeSessionStore] loadFile: corrupted claude-sessions.json reinitialized at \(url.path)\n"
          .utf8))
    return empty
  }

  private func saveFile(_ list: Gozd_V1_ClaudeSessionList, for dir: String) throws {
    let url = fileURL(for: dir)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let json = try list.jsonString()
    try json.write(to: url, atomically: true, encoding: .utf8)
  }
}
