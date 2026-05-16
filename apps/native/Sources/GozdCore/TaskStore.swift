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
//    の起点に使う。body / pr_number / issue_number がいずれも空の task のみ削除する。
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
  public func add(
    dir: String, body: String, worktreeDir: String, prNumber: UInt32, issueNumber: UInt32
  ) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    var task = Gozd_V1_Task()
    task.id = UUID().uuidString
    task.body = body
    task.worktreeDir = worktreeDir
    task.prNumber = prNumber
    task.issueNumber = issueNumber
    task.createdAt = ISO8601DateFormatter().string(from: Date())
    list.tasks.append(task)
    try saveFile(list, for: dir)
    return task
  }

  /// 明示的な削除。サイドバー ⋮ メニュー「Remove task」等から呼ばれる。
  public func remove(dir: String, id: String) throws {
    var list = try loadFile(for: dir)
    let before = list.tasks.count
    list.tasks.removeAll { $0.id == id }
    guard list.tasks.count != before else {
      throw TaskStoreError.notFound(id)
    }
    try saveFile(list, for: dir)
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
  /// body / pr_number / issue_number がすべて空の task は session が唯一の identity
  /// 源だったので削除する (Claude 直接起動 + 即終了の残骸を掃除)。
  public func detachSession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    let task = list.tasks[idx]
    if task.body.isEmpty && task.prNumber == 0 && task.issueNumber == 0 {
      list.tasks.remove(at: idx)
    }
    // sessionID は保持。再 resume 経路で使う。body/pr/issue があれば task も残す。
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
  /// クリアし、加えて「body / pr / issue いずれも空」かつ「sessionID も dead」の
  /// task は孤児として削除する (AND 条件)。
  ///
  /// task.sessionID は SessionEnd でも保持する設計なので、resume が永久に効かなくなった
  /// dead session id をクリアして次回クリック時に「素の claude」を起動できる状態に戻す。
  /// pr / issue / body が残っていれば task 本体は維持する。
  /// この経路が無いと、アプリクラッシュ / kill -9 / transcript 削除で session-end hook も
  /// removeByPty も来なかった残骸が永続化に居座り続け、サイドバーに `New session` の
  /// ゾンビ行として現れる。
  /// 戻り値: tasks.json / claude-sessions.json のいずれかが「読めない or parse できない」
  /// 理由で skip した projectKey 一覧 (UTF-8 デコード失敗・proto JSON parse 失敗を含む)。
  /// 呼び出し元はこれを renderer に notify push して、ユーザーに復旧操作を促す。
  public func reconcileAll() throws -> [String] {
    let projectsURL = URL(fileURLWithPath: configDir).appendingPathComponent("projects")
    let fm = FileManager.default
    guard fm.fileExists(atPath: projectsURL.path) else { return [] }
    // macOS では .DS_Store などの hidden entry が projects/ 直下に紛れ込みうるため、
    // URL ベース API + .skipsHiddenFiles で除外する。tasks.json 不在の continue でも
    // 動作上は問題ないが、無駄な iteration / 誤った projectKey 出現を未然に防ぐ。
    let projectDirs = try fm.contentsOfDirectory(
      at: projectsURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )
    var totalDropped = 0
    // tasks.json / claude-sessions.json の read or parse 失敗を統合して集計する。
    // 上位 (RpcDispatcher.reconcileClaudeSessions) は notify メッセージで
    // 「Failed to parse claude-sessions.json」と書いていたが、tasks.json 側 / UTF-8 側
    // の失敗も同じ復旧操作 (該当 projectKey の手動修復) を要するので 1 つにまとめる。
    var decodeFailureProjects: [String] = []
    for projectDir in projectDirs {
      let projectKey = projectDir.lastPathComponent
      let tasksURL = projectDir.appendingPathComponent("tasks.json")
      guard fm.fileExists(atPath: tasksURL.path) else { continue }
      let tasksData = try Data(contentsOf: tasksURL)
      // 不正な UTF-8 を U+FFFD で黙置換する `String(decoding:as:)` は使わない
      // (silent corruption の温床)。デコード失敗時は projectKey ごと skip + notify 対象。
      guard let tasksJson = String(bytes: tasksData, encoding: .utf8) else {
        FileHandle.standardError.write(
          Data(
            "[TaskStore] reconcile: tasks.json is not valid UTF-8 for \(projectKey), skipping\n"
              .utf8))
        decodeFailureProjects.append(projectKey)
        continue
      }
      // proto JSON parse 失敗も skip + notify 対象 (silent に空 list として進めると
      // 後段の orphan 削除で生きている Task まで巻き添えになる)。
      guard let parsedTaskList = try? Gozd_V1_TaskList(jsonString: tasksJson) else {
        FileHandle.standardError.write(
          Data(
            "[TaskStore] reconcile: failed to parse tasks.json for \(projectKey), skipping\n"
              .utf8))
        decodeFailureProjects.append(projectKey)
        continue
      }
      var taskList = parsedTaskList
      if taskList.tasks.isEmpty { continue }

      // 同 projectKey の生存 sessionId を計算する。
      // claude-sessions.json が存在しない / 空なら、その projectKey の Task は
      // 全件孤児扱い。reconcileAll の順序として ClaudeSessionStore → TaskStore
      // で動かす前提なので、claude-sessions.json は既に reconcile 済み。
      var liveSessionIds: Set<String> = []
      let sessionsURL = projectDir.appendingPathComponent("claude-sessions.json")
      if fm.fileExists(atPath: sessionsURL.path) {
        let sessionsData = try Data(contentsOf: sessionsURL)
        // UTF-8 デコード失敗は parse 失敗と同じ扱い (生存判定根拠が欠落) で skip。
        guard let sessionsJson = String(bytes: sessionsData, encoding: .utf8) else {
          FileHandle.standardError.write(
            Data(
              "[TaskStore] reconcile: claude-sessions.json is not valid UTF-8 for \(projectKey), skipping\n"
                .utf8))
          decodeFailureProjects.append(projectKey)
          continue
        }
        guard let sessionList = try? Gozd_V1_ClaudeSessionList(jsonString: sessionsJson)
        else {
          // parse 失敗時は「session 全滅」と判定する根拠が無いため projectKey ごと skip。
          // 一時的なディスク破損 / 中断書き込みで生きている Task まで巻き添えに削除されないようにする。
          FileHandle.standardError.write(
            Data(
              "[TaskStore] reconcile: failed to parse claude-sessions.json for \(projectKey), skipping\n"
                .utf8))
          decodeFailureProjects.append(projectKey)
          continue
        }
        for session in sessionList.sessions {
          liveSessionIds.insert(session.sessionID)
        }
      }

      let before = taskList.tasks.count
      var mutated = false
      // dead sessionID をクリア (task 本体は保持。pr/issue/body の有無に依らない)。
      for idx in taskList.tasks.indices {
        let sid = taskList.tasks[idx].sessionID
        if !sid.isEmpty && !liveSessionIds.contains(sid) {
          taskList.tasks[idx].sessionID = ""
          mutated = true
        }
      }
      // identity 源が完全に消えた task を削除: body / pr / issue / sessionID すべて空。
      taskList.tasks.removeAll {
        $0.body.isEmpty && $0.prNumber == 0 && $0.issueNumber == 0 && $0.sessionID.isEmpty
      }
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
    return decodeFailureProjects
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
    // 不正な UTF-8 / proto JSON parse 失敗を silent に「空 list」として扱うと、
    // 直後の save で空 list を書き戻し、ユーザーの全 task が消える破壊的副作用がある
    // (一時的なディスク破損 / 中断書き込みでも発動)。throw に倒して上位 (RpcDispatcher)
    // で notify + UI に伝え、ユーザーが復旧操作 (手動修復 / 削除) を選べるようにする。
    guard let json = String(bytes: data, encoding: .utf8) else {
      throw TaskStoreError.fileDecodeFailed(path)
    }
    return try Gozd_V1_TaskList(jsonString: json)
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
  case fileDecodeFailed(String)
}
