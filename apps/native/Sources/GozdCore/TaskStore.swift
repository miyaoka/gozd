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
    return decodeFailureProjects
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
    // 不正な UTF-8 / proto JSON parse 失敗を silent に「空 list」として扱うと、
    // 直後の save で空 list を書き戻し、ユーザーの全 task が消える破壊的副作用がある
    // (一時的なディスク破損 / 中断書き込みでも発動)。throw に倒して上位 (RpcDispatcher)
    // で notify + UI に伝え、ユーザーが復旧操作 (手動修復 / 削除) を選べるようにする。
    guard let json = String(bytes: data, encoding: .utf8) else {
      throw TaskStoreError.fileDecodeFailed(url.path)
    }
    return try Gozd_V1_TaskList(jsonString: json)
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
  case fileDecodeFailed(String)
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
