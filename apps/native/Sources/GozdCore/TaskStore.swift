import Foundation
import GozdProto

// プロジェクト固有 Task の永続化（`~/.config/gozd/projects/<projectKey>/tasks.json`）。
//
// 設計判断:
//
// 1. **projectKey の算出は `ProjectKey` を参照**。worktree 配下のどの dir から呼ばれても
//    main repo root に解決した上で同一 projectKey に揃える（`resolveAndCompute`）。
//
// 2. **永続化形式は proto JSON**。AppStateStore / AppConfigStore と同流儀。
//    `TaskList` ラッパーを介して `tasks` を array として保存する。
//
// 3. **actor**。読み書きが直列化されるよう actor 化。複数 RPC が並行で書きにくる
//    シナリオでファイルが破損するのを防ぐ。
public actor TaskStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  public func list(dir: String) throws -> [Gozd_V1_Task] {
    return try loadFile(for: dir).tasks
  }

  public func add(dir: String, body: String, worktreeDir: String, prNumber: UInt32, issueNumber: UInt32)
    throws -> Gozd_V1_Task
  {
    var list = try loadFile(for: dir)
    var task = Gozd_V1_Task()
    task.id = newTaskId()
    task.body = body
    task.worktreeDir = worktreeDir
    task.prNumber = prNumber
    task.issueNumber = issueNumber
    task.createdAt = ISO8601DateFormatter().string(from: Date())
    list.tasks.append(task)
    try saveFile(list, for: dir)
    return task
  }

  public func update(dir: String, id: String, body: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].body = body
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  public func setWorktreeDir(dir: String, id: String, worktreeDir: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].worktreeDir = worktreeDir
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  public func remove(dir: String, id: String) throws {
    var list = try loadFile(for: dir)
    list.tasks.removeAll { $0.id == id }
    try saveFile(list, for: dir)
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

  /// session-end hook 由来の自動削除。手動 remove と挙動は同じ。
  public func removeBySession(dir: String, sessionId: String) throws {
    try remove(dir: dir, id: sessionId)
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

  private func newTaskId() -> String {
    return UUID().uuidString.lowercased()
  }
}

public enum TaskStoreError: Error, Equatable {
  case notFound(String)
}
