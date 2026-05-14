import Foundation
import GozdProto

// プロジェクト固有 Task の永続化（`~/.config/gozd/projects/<projectKey>/tasks.json`）。
//
// task = Claude session の同一視ルール。
//
// 設計判断:
//
// 1. **task.id = session_id**。SessionStart hook で upsert、SessionEnd で remove する。
//    手動 CRUD API は廃止し、外部 mutation は body 同期 (update) のみ公開する。
//
// 2. **projectKey の算出は `ProjectKey` を参照**。worktree 配下のどの dir から呼ばれても
//    main repo root に解決した上で同一 projectKey に揃える（`resolveAndCompute`）。
//
// 3. **永続化形式は proto JSON**。AppStateStore / AppConfigStore と同流儀。
//    `TaskList` ラッパーを介して `tasks` を array として保存する。
//
// 4. **actor**。読み書きが直列化されるよう actor 化。複数 RPC が並行で書きにくる
//    シナリオでファイルが破損するのを防ぐ。
public actor TaskStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  /// projectKey 内の全 Task を返す。RpcDispatcher.handleGitWorktreeList で
  /// WorktreeEntry.tasks を埋めるために使う。
  public func list(dir: String) throws -> [Gozd_V1_Task] {
    return try loadFile(for: dir).tasks
  }

  /// Task body を OSC ターミナルタイトル経由で書き換える。renderer 側 useSidebarData
  /// から呼ばれる唯一の public mutation API。生成 / 削除は session hook が担う。
  public func update(dir: String, id: String, body: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].body = body
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  /// Claude session-start hook 由来の Task を upsert する。
  /// task.id = session_id の同一視ルール。既に同一 id があれば worktreeDir のみ更新する。
  /// body は OSC ターミナルタイトル経由で renderer が後から rpcTaskUpdate するため
  /// 初回は空のまま登録する。
  public func upsertForSession(dir: String, sessionId: String, worktreeDir: String) throws {
    var list = try loadFile(for: dir)
    if let idx = list.tasks.firstIndex(where: { $0.id == sessionId }) {
      list.tasks[idx].worktreeDir = worktreeDir
    } else {
      var task = Gozd_V1_Task()
      task.id = sessionId
      task.body = ""
      task.worktreeDir = worktreeDir
      task.createdAt = ISO8601DateFormatter().string(from: Date())
      list.tasks.append(task)
    }
    try saveFile(list, for: dir)
  }

  /// session-end hook 由来の自動削除。task.id == sessionId の前提。
  public func removeBySession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    list.tasks.removeAll { $0.id == sessionId }
    try saveFile(list, for: dir)
  }

  /// worktree 物理削除 (handleWorktreeRemove) からの連動掃除。
  /// 該当 worktreeDir に紐づく全 Task を削除する。`ClaudeSessionStore.
  /// removeByWorktreePath` と対称の経路で、worktree 削除後に Task が
  /// 孤児として永続化に残るのを防ぐ。
  public func removeByWorktree(dir: String, worktreePath: String) throws {
    var list = try loadFile(for: dir)
    list.tasks.removeAll { $0.worktreeDir == worktreePath }
    try saveFile(list, for: dir)
  }

  /// 起動時の reconcile。各 projectKey で `claude-sessions.json` の生存
  /// sessionId 集合に含まれない Task を孤児として掃除する。
  ///
  /// task.id == sessionId 同一視 と、ClaudeSessionStore.reconcileAll
  /// が transcript ファイル不在を根拠に dead session を落とすことを前提に、
  /// 「session が無いのに Task だけ残っている」状態を死亡判定する。
  /// この経路が無いと、アプリクラッシュ / kill -9 / transcript 削除で
  /// session-end hook も removeByPty も来なかった残骸が永続化に居座り続け、
  /// サイドバーに `New session` のゾンビ行として現れる。
  /// 戻り値: claude-sessions.json の parse 失敗で skip した projectKey 一覧。
  /// 呼び出し元はこれを renderer に notify push して、ユーザーに復旧操作を促す。
  public func reconcileAll() throws -> [String] {
    let projectsURL = URL(fileURLWithPath: configDir).appendingPathComponent("projects")
    let fm = FileManager.default
    guard fm.fileExists(atPath: projectsURL.path) else { return [] }
    let projectKeys = try fm.contentsOfDirectory(atPath: projectsURL.path)
    var totalDropped = 0
    var parseFailureProjects: [String] = []
    for projectKey in projectKeys {
      let projectDir = projectsURL.appendingPathComponent(projectKey)
      let tasksURL = projectDir.appendingPathComponent("tasks.json")
      guard fm.fileExists(atPath: tasksURL.path) else { continue }
      let tasksData = try Data(contentsOf: tasksURL)
      let tasksJson = String(decoding: tasksData, as: UTF8.self)
      var taskList =
        (try? Gozd_V1_TaskList(jsonString: tasksJson)) ?? Gozd_V1_TaskList()
      if taskList.tasks.isEmpty { continue }

      // 同 projectKey の生存 sessionId を計算する。
      // claude-sessions.json が存在しない / 空なら、その projectKey の Task は
      // 全件孤児扱い。reconcileAll の順序として ClaudeSessionStore → TaskStore
      // で動かす前提なので、claude-sessions.json は既に reconcile 済み。
      var liveSessionIds: Set<String> = []
      let sessionsURL = projectDir.appendingPathComponent("claude-sessions.json")
      if fm.fileExists(atPath: sessionsURL.path) {
        let sessionsData = try Data(contentsOf: sessionsURL)
        let sessionsJson = String(decoding: sessionsData, as: UTF8.self)
        guard let sessionList = try? Gozd_V1_ClaudeSessionList(jsonString: sessionsJson)
        else {
          // parse 失敗時は「session 全滅」と判定する根拠が無いため projectKey ごと skip。
          // 一時的なディスク破損 / 中断書き込みで生きている Task まで巻き添えに削除されないようにする。
          FileHandle.standardError.write(
            Data(
              "[TaskStore] reconcile: failed to parse claude-sessions.json for \(projectKey), skipping\n"
                .utf8))
          parseFailureProjects.append(projectKey)
          continue
        }
        for session in sessionList.sessions {
          liveSessionIds.insert(session.sessionID)
        }
      }

      let before = taskList.tasks.count
      taskList.tasks.removeAll { !liveSessionIds.contains($0.id) }
      let dropped = before - taskList.tasks.count
      if dropped > 0 {
        let outJson = try taskList.jsonString()
        try outJson.write(to: tasksURL, atomically: true, encoding: .utf8)
        totalDropped += dropped
        FileHandle.standardError.write(
          Data(
            "[TaskStore] reconcile: dropped \(dropped) orphan tasks from \(projectKey)\n"
              .utf8))
      }
    }
    if totalDropped > 0 {
      FileHandle.standardError.write(
        Data("[TaskStore] reconcile: total \(totalDropped) orphan tasks cleaned\n".utf8))
    }
    return parseFailureProjects
  }

  // MARK: - paths

  private func projectDir(for dir: String) -> String {
    let projectKey = ProjectKey.resolveAndCompute(for: dir)
    return (configDir as NSString)
      .appendingPathComponent("projects")
      .appending("/\(projectKey)")
  }

  private func tasksFilePath(for dir: String) -> String {
    return (projectDir(for: dir) as NSString).appendingPathComponent("tasks.json")
  }

  private func loadFile(for dir: String) throws -> Gozd_V1_TaskList {
    let path = tasksFilePath(for: dir)
    if !FileManager.default.fileExists(atPath: path) {
      return Gozd_V1_TaskList()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let json = String(decoding: data, as: UTF8.self)
    // 壊れたファイル / 旧形式は空 list として扱い、次回 save で上書きする。
    // 後方互換コードは負債になるので、復旧は「捨てて作り直す」方針。
    return (try? Gozd_V1_TaskList(jsonString: json)) ?? Gozd_V1_TaskList()
  }

  private func saveFile(_ list: Gozd_V1_TaskList, for dir: String) throws {
    let path = tasksFilePath(for: dir)
    let dirPath = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dirPath, withIntermediateDirectories: true)
    let json = try list.jsonString()
    try json.write(toFile: path, atomically: true, encoding: .utf8)
  }

}

public enum TaskStoreError: Error, Equatable {
  case notFound(String)
}
