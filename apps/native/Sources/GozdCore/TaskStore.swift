import Foundation
import GozdProto

// プロジェクト固有 Task の永続化（`~/.config/gozd/projects/<projectKey>/tasks.json`）。
//
// task ≠ Claude session。task は PR/issue/手動操作で生まれる永続オブジェクトで、
// Claude session は task に attach する短命属性 (task.sessionID) として持つ。
//
// 設計判断:
//
// 1. **task.id は UUID**。Claude session とは独立した identity。session の生成 / 消滅で
//    task は再作成されない。
//
// 2. **SessionStart hook**: 該当 worktreeDir で sessionID 空の最新 task に attach する。
//    無ければ新規 task を作る (Claude 直接起動 = PR/issue 経由でないケース)。
//
// 3. **SessionEnd hook**: task.sessionID を切り離さず保持する。次回 `claude --resume`
//    の起点に使う。body / gh_ref がいずれも空の task のみ削除する。
//
// 4. **projectKey の算出は `ProjectKey` を参照**。worktree 配下のどの dir から呼ばれても
//    main repo root に解決した上で同一 projectKey に揃える（`resolveAndCompute`）。
//
// 5. **永続化形式は proto JSON**。AppStateStore / AppConfigStore と同流儀。
//    `TaskList` ラッパーを介して `tasks` を array として保存する。
//
// 6. **actor**。読み書きが直列化されるよう actor 化。複数 RPC が並行で書きにくる
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

  /// 新規 Task を作成する。PR/issue picker や手動操作から呼ばれる。
  /// id は UUID で生成。session は未 attach (sessionID 空) の状態で開始する。
  /// `createdAt` を省略すると現在時刻 (ISO 8601) を埋める。テスト時に明示的な順序を
  /// 仕込みたい場合のみ caller が文字列で与える (本体経路では渡さない)。
  public func add(
    dir: String, body: String, worktreeDir: String, ghRef: Gozd_V1_GhRef?,
    createdAt: String? = nil
  ) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    var task = Gozd_V1_Task()
    task.id = UUID().uuidString
    task.body = body
    task.worktreeDir = worktreeDir
    if let ghRef { task.ghRef = ghRef }
    task.createdAt = createdAt ?? ISO8601DateFormatter().string(from: Date())
    list.tasks.append(task)
    try saveFile(list, for: dir)
    return task
  }

  /// Task body を OSC ターミナルタイトル経由で書き換える。renderer 側 useSidebarData
  /// から呼ばれる。
  public func update(dir: String, id: String, body: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].body = body
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  /// Claude session-start hook を Task に attach する。
  ///
  /// 優先順位:
  ///   1. 既に sessionID が一致する task → no-op (idempotent)
  ///   2. 同一 worktreeDir で sessionID 空の task のうち最新のもの (createdAt 降順) に attach
  ///   3. 該当無し → 新規 task を作成し sessionID を入れる (Claude 直接起動経路)
  public func attachSession(dir: String, sessionId: String, worktreeDir: String) throws {
    var list = try loadFile(for: dir)
    if list.tasks.contains(where: { $0.sessionID == sessionId }) {
      return
    }
    let candidates = list.tasks.enumerated().filter {
      $0.element.worktreeDir == worktreeDir && $0.element.sessionID.isEmpty
    }
    if let pick = candidates.max(by: { $0.element.createdAt < $1.element.createdAt }) {
      list.tasks[pick.offset].sessionID = sessionId
    } else {
      var task = Gozd_V1_Task()
      task.id = UUID().uuidString
      task.body = ""
      task.worktreeDir = worktreeDir
      task.sessionID = sessionId
      task.createdAt = ISO8601DateFormatter().string(from: Date())
      list.tasks.append(task)
    }
    try saveFile(list, for: dir)
  }

  /// SessionEnd hook 由来。task.sessionID は保持して `claude --resume` の起点に使う。
  /// 削除判定は `hasNonSessionIdentity` (body / gh_ref) で行う。sessionID を
  /// この判定に含めると「再 resume 用に sessionID を残す」設計と矛盾するため除外する。
  public func detachSession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    if !list.tasks[idx].hasNonSessionIdentity {
      list.tasks.remove(at: idx)
    }
    // identity (body / gh_ref) があれば sessionID は保持。worktreeList の filter は
    // identity の有無で判定するため、sessionID を残してもサイドバー表示には影響しない。
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

  /// 起動時の reconcile。dead session を attach したまま放置された task の sessionID を
  /// クリアし、加えて「body / gh_ref いずれも空」かつ「sessionID も dead」の task は
  /// 孤児として削除する (AND 条件)。
  ///
  /// parse 失敗 (UTF-8 不正 / JSON syntax 不正 / proto schema 進化) の永続化ファイルは
  /// 空オブジェクトで上書き save する。本アプリはベータ版で永続データに後方互換を作らない
  /// (CLAUDE.md 規約)。schema 進化で旧 JSON が parse 失敗した時は新規初期化が期待挙動。
  public func reconcileAll() throws {
    let projectsURL = URL(fileURLWithPath: configDir).appendingPathComponent("projects")
    let fm = FileManager.default
    guard fm.fileExists(atPath: projectsURL.path) else { return }
    let projectDirs = try fm.contentsOfDirectory(
      at: projectsURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )
    var totalDropped = 0
    for projectDir in projectDirs {
      let projectKey = projectDir.lastPathComponent
      let tasksURL = projectDir.appendingPathComponent("tasks.json")
      guard fm.fileExists(atPath: tasksURL.path) else { continue }
      let tasksData = try Data(contentsOf: tasksURL)
      var taskList: Gozd_V1_TaskList
      if let tasksJson = String(bytes: tasksData, encoding: .utf8),
        let parsed = try? Gozd_V1_TaskList(jsonString: tasksJson)
      {
        taskList = parsed
      } else {
        let empty = Gozd_V1_TaskList()
        let emptyJson = try empty.jsonString()
        try emptyJson.write(to: tasksURL, atomically: true, encoding: .utf8)
        FileHandle.standardError.write(
          Data(
            "[TaskStore] reconcile: corrupted tasks.json reinitialized for \(projectKey)\n"
              .utf8))
        continue
      }
      if taskList.tasks.isEmpty { continue }

      // dead session 判定の根拠は claude-sessions.json。破損していれば「空」と
      // 取り違えて全 task を orphan 化する事故になるため、parse 失敗時は当該 projectKey
      // の dead session 判定をスキップして次に進む (`continue`)。
      var liveSessionIds: Set<String> = []
      let sessionsURL = projectDir.appendingPathComponent("claude-sessions.json")
      if fm.fileExists(atPath: sessionsURL.path) {
        let sessionsData = try Data(contentsOf: sessionsURL)
        if let sessionsJson = String(bytes: sessionsData, encoding: .utf8),
          let sessionList = try? Gozd_V1_ClaudeSessionList(jsonString: sessionsJson)
        {
          for session in sessionList.sessions {
            liveSessionIds.insert(session.sessionID)
          }
        } else {
          let empty = Gozd_V1_ClaudeSessionList()
          let emptyJson = try empty.jsonString()
          try emptyJson.write(to: sessionsURL, atomically: true, encoding: .utf8)
          FileHandle.standardError.write(
            Data(
              "[TaskStore] reconcile: corrupted claude-sessions.json reinitialized for \(projectKey)\n"
                .utf8))
          continue
        }
      }

      let before = taskList.tasks.count
      var mutated = false
      // dead sessionID をクリア (task 本体は保持。body / gh_ref の有無に依らない)。
      for idx in taskList.tasks.indices {
        let sid = taskList.tasks[idx].sessionID
        if !sid.isEmpty && !liveSessionIds.contains(sid) {
          taskList.tasks[idx].sessionID = ""
          mutated = true
        }
      }
      // identity 源が完全に消えた task を削除 (detachSession と SSOT)。
      taskList.tasks.removeAll { $0.isOrphan }
      let dropped = before - taskList.tasks.count
      if dropped > 0 { mutated = true }
      if mutated {
        let outJson = try taskList.jsonString()
        try outJson.write(to: tasksURL, atomically: true, encoding: .utf8)
        totalDropped += dropped
        if dropped > 0 {
          FileHandle.standardError.write(
            Data(
              "[TaskStore] reconcile: dropped \(dropped) orphan tasks from \(projectKey)\n"
                .utf8))
        }
      }
    }
    if totalDropped > 0 {
      FileHandle.standardError.write(
        Data("[TaskStore] reconcile: total \(totalDropped) orphan tasks cleaned\n".utf8))
    }
  }

  // MARK: - paths

  private func projectDir(for dir: String) -> URL {
    let projectKey = ProjectKey.resolveAndCompute(for: dir)
    return URL(fileURLWithPath: configDir)
      .appendingPathComponent("projects")
      .appendingPathComponent(projectKey)
  }

  private func tasksFilePath(for dir: String) -> URL {
    return projectDir(for: dir).appendingPathComponent("tasks.json")
  }

  private func loadFile(for dir: String) throws -> Gozd_V1_TaskList {
    let url = tasksFilePath(for: dir)
    if !FileManager.default.fileExists(atPath: url.path) {
      return Gozd_V1_TaskList()
    }
    let data = try Data(contentsOf: url)
    if let json = String(bytes: data, encoding: .utf8),
      let list = try? Gozd_V1_TaskList(jsonString: json)
    {
      return list
    }
    let empty = Gozd_V1_TaskList()
    try saveFile(empty, for: dir)
    FileHandle.standardError.write(
      Data("[TaskStore] loadFile: corrupted tasks.json reinitialized at \(url.path)\n".utf8))
    return empty
  }

  private func saveFile(_ list: Gozd_V1_TaskList, for dir: String) throws {
    let url = tasksFilePath(for: dir)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let json = try list.jsonString()
    try json.write(to: url, atomically: true, encoding: .utf8)
  }

}

public enum TaskStoreError: Error, Equatable {
  case notFound(String)
}

extension Gozd_V1_Task {
  /// task が session 以外の identity 源 (body / gh_ref) を持つか。1 項でもあれば true。
  /// detachSession の保持判定 / handleGitWorktreeList の filter / reconcileAll の孤児判定で共通利用する。
  public var hasNonSessionIdentity: Bool {
    !body.isEmpty || hasGhRef
  }

  /// 「task の identity が完全に消えた」判定 (reconcileAll 専用)。body / gh_ref / sessionID
  /// すべて空が条件 (= `hasNonSessionIdentity` false かつ sessionID 空)。
  public var isOrphan: Bool {
    !hasNonSessionIdentity && sessionID.isEmpty
  }
}

extension Gozd_V1_GhRef {
  /// kind を取り違える可能性を構造的に排除するためのドメインファクトリ。
  /// TS 側 `ghRefForPr` / `ghRefForIssue` (proto-ts/src/helpers.ts) と対称。
  public static func forPr(_ number: UInt32) -> Gozd_V1_GhRef {
    var ref = Gozd_V1_GhRef()
    ref.kind = .pr
    ref.number = number
    return ref
  }

  public static func forIssue(_ number: UInt32) -> Gozd_V1_GhRef {
    var ref = Gozd_V1_GhRef()
    ref.kind = .issue
    ref.number = number
    return ref
  }
}
