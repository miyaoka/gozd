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
// 3. **read API は read だけ**。`liveSessions` / `allLiveSessions` は pure read で
//    silent な save をしない。クラッシュ等で session-end が走らなかった残骸は、
//    起動時の `reconcileAll()` が transcript ファイル不在を理由にまとめて掃除する。
//    read のたびに silent save する旧設計は「いつ何が消えたか」が観察できないため撤去。
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
  /// transcript ファイルが存在するものだけを返す（pure read。silent な save はしない）。
  /// 残骸は起動時の `reconcileAll()` が責任を持って掃除する。
  public func liveSessions(for dir: String) throws -> [Gozd_V1_ClaudeSession] {
    let list = try loadFile(for: dir)
    return list.sessions.filter { entry in
      entry.worktreePath == dir
        && FileManager.default.fileExists(atPath: entry.transcriptPath)
    }
  }

  /// プロジェクト全体の生存セッションを返す（worktree 横断、pure read）。
  /// サイドバーが「各 worktree が何個 resume 可能か」をバッジ表示するための一括取得。
  /// transcript ファイルの存在チェックを通して死んだ session を弾く。
  public func allLiveSessions(forProject dir: String) throws -> [Gozd_V1_ClaudeSession] {
    let list = try loadFile(for: dir)
    return list.sessions.filter {
      FileManager.default.fileExists(atPath: $0.transcriptPath)
    }
  }

  /// プロジェクト全体の登録 session を返す（transcript 存在チェックを通さない）。
  /// session-start hook 直後は Claude が transcript ファイル本体をまだ作成していない
  /// (初回 message 時に書かれる) ため、`allLiveSessions` で filter すると稼働中の
  /// session が一瞬「不在」と判定されてしまう。アプリ稼働中の Task ↔ session 整合性は
  /// session-start hook の upsert と session-end / removeByPty の delete で完全管理
  /// されているので、稼働中判定はこの method で transcript チェックなしに行う。
  /// 死んだ session の掃除は起動時 reconcileAll が責任を持つ。
  public func allRegisteredSessions(forProject dir: String) throws -> [Gozd_V1_ClaudeSession] {
    let list = try loadFile(for: dir)
    return list.sessions
  }

  /// 起動時に 1 回呼ぶ reconcile。`~/.config/gozd/projects/*/claude-sessions.json` を
  /// 走査して、transcript ファイルが消滅したエントリを落とす。落とした件数を stderr に
  /// ログ出力する(観察可能性確保)。read 時 silent save の代替経路。
  public func reconcileAll() throws {
    let projectsURL = URL(fileURLWithPath: configDir).appendingPathComponent("projects")
    let fm = FileManager.default
    guard fm.fileExists(atPath: projectsURL.path) else { return }
    let projectKeys = try fm.contentsOfDirectory(atPath: projectsURL.path)
    var totalDropped = 0
    for projectKey in projectKeys {
      let fileURL = projectsURL
        .appendingPathComponent(projectKey)
        .appendingPathComponent("claude-sessions.json")
      guard fm.fileExists(atPath: fileURL.path) else { continue }
      let data = try Data(contentsOf: fileURL)
      var list: Gozd_V1_ClaudeSessionList
      if let json = String(bytes: data, encoding: .utf8),
        let parsed = try? Gozd_V1_ClaudeSessionList(jsonString: json)
      {
        list = parsed
      } else {
        let empty = Gozd_V1_ClaudeSessionList()
        let emptyJson = try empty.jsonString()
        try emptyJson.write(to: fileURL, atomically: true, encoding: .utf8)
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] reconcile: corrupted claude-sessions.json reinitialized for \(projectKey)\n"
              .utf8))
        continue
      }
      let before = list.sessions.count
      list.sessions.removeAll { entry in
        !FileManager.default.fileExists(atPath: entry.transcriptPath)
      }
      let dropped = before - list.sessions.count
      if dropped > 0 {
        let outJson = try list.jsonString()
        try outJson.write(to: fileURL, atomically: true, encoding: .utf8)
        totalDropped += dropped
        FileHandle.standardError.write(
          Data(
            "[ClaudeSessionStore] reconcile: dropped \(dropped) dead entries from \(projectKey)\n"
              .utf8))
      }
    }
    if totalDropped > 0 {
      FileHandle.standardError.write(
        Data("[ClaudeSessionStore] reconcile: total \(totalDropped) dead entries cleaned\n".utf8))
    }
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
    if let json = String(bytes: data, encoding: .utf8),
      let list = try? Gozd_V1_ClaudeSessionList(jsonString: json)
    {
      return list
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
