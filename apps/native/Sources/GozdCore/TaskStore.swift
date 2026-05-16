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
//    の起点に使う。gh_ref が空の task のみ削除する。body は identity に含めない
//    (Claude が OSC タイトル経由で書く揮発メタデータであり、ユーザー意思ではないため)。
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

  /// Task を作成または再活性化する。PR/issue picker や手動操作から呼ばれる。
  ///
  /// 動作:
  ///   - `ghRef` 指定があり、同 `worktreeDir` + 同 `ghRef` の既存 task が見つかれば
  ///     **upsert**: `hidden` を false に戻し、`body` を最新の PR/issue タイトルで
  ///     上書きして返す。createdAt / id / sessionID は保持する。
  ///   - それ以外は新規 task を UUID で作成。`createdAt` を省略すると現在時刻
  ///     (ISO 8601)。テスト時の順序仕込み用に caller が文字列で与えられる。
  ///
  /// upsert を入れた理由: terminal close で `detachSession` が `ghRef` 持ち task に
  /// hidden=true を立てるため、再度 PR/issue picker で同じ PR を選んだときに再表示
  /// する経路が必要。wtByBranch hit ルート (既存 worktree 切替) でも picker から
  /// `add` が呼ばれる前提で、ここで identity 単位の冪等再活性化を完結させる。
  public func add(
    dir: String, body: String, worktreeDir: String, ghRef: Gozd_V1_GhRef?,
    createdAt: String? = nil
  ) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    if let ghRef,
      let idx = list.tasks.firstIndex(where: {
        $0.worktreeDir == worktreeDir && $0.hasGhRef && $0.ghRef == ghRef
      })
    {
      list.tasks[idx].body = body
      list.tasks[idx].hidden = false
      try saveFile(list, for: dir)
      return list.tasks[idx]
    }
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
    if let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) {
      // 既存 attach は冪等で抜ける前に hidden だけは解除する。サイドバーから
      // 隠した task に対して resume クリック等で再 SessionStart が来た場合に
      // 表示を復活させるため。
      if list.tasks[idx].hidden {
        list.tasks[idx].hidden = false
        try saveFile(list, for: dir)
      }
      return
    }
    let candidates = list.tasks.enumerated().filter {
      $0.element.worktreeDir == worktreeDir && $0.element.sessionID.isEmpty
    }
    if let pick = candidates.max(by: { $0.element.createdAt < $1.element.createdAt }) {
      list.tasks[pick.offset].sessionID = sessionId
      list.tasks[pick.offset].hidden = false
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

  /// SessionEnd hook / terminal close 由来。
  ///
  /// 動作:
  ///   - `gh_ref` 持ち task: 削除せず `hidden=true` を立て、`sessionID` は保持する。
  ///     サイドバー表示は消えるが、PR/issue 永続情報と `claude --resume` の起点は
  ///     残る。同じ PR/issue を picker で再選択すると `add` の upsert 経路で
  ///     `hidden=false` に戻り表示が復活する。
  ///   - `gh_ref` 無し task: 従来通り削除する (Claude 直接起動 + 即終了の残骸掃除)。
  ///
  /// sessionID 単独では身元にしない: 「再 resume 用に sessionID を残す」設計と
  /// 矛盾するため、`hasNonSessionIdentity` で判定する。
  public func detachSession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    if list.tasks[idx].hasNonSessionIdentity {
      list.tasks[idx].hidden = true
    } else {
      list.tasks.remove(at: idx)
    }
    try saveFile(list, for: dir)
  }

  /// resume 失敗検出経路 (claude --resume が transcript 不在等で error 終了) で呼ぶ。
  /// 該当 sid を持つ task に対し、ghRef があれば sessionID を空に書き換え、無ければ
  /// task ごと削除する。`detachSession` との違いは「identity ありでも sessionID を
  /// クリアする」こと。次のクリックで `--resume` ではなく素の `claude` 起動経路に流す
  /// ためで、SessionEnd 由来の detach (resume 期待で sid を保持する) とは意図が異なる。
  public func clearDeadSession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    if list.tasks[idx].hasNonSessionIdentity {
      list.tasks[idx].sessionID = ""
      // terminal close + resume 失敗の経路 (removeByPty) は SessionEnd と同様に
      // サイドバー表示も消す。直後の attachSession(新 sid) で同 worktree の最新
      // sessionID 空 task がピックされたら hidden=false に戻り表示が復活する
      // (resume 失敗 + zsh fallback で新 sid 着弾するケース)。
      list.tasks[idx].hidden = true
    } else {
      list.tasks.remove(at: idx)
    }
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
    if let json = String(bytes: data, encoding: .utf8) {
      do {
        return try Gozd_V1_TaskList(jsonString: json)
      } catch {
        FileHandle.standardError.write(
          Data(
            "[TaskStore] loadFile: parse failed at \(url.path): \(error)\n"
              .utf8))
      }
    } else {
      FileHandle.standardError.write(
        Data("[TaskStore] loadFile: invalid UTF-8 at \(url.path)\n".utf8))
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
  /// task が session 以外の identity 源 (gh_ref) を持つか。
  /// detachSession の保持判定 / handleGitWorktreeList の filter で共通利用する。
  ///
  /// body は識別子に含めない。Claude が OSC ターミナルタイトル経由で自動付与する
  /// メタデータであり、ユーザー意思の identity ではないため。terminal を閉じた時点で
  /// body しか持たない task (root wt 上で直接 claude を起動したケース等) は揮発させる。
  /// 一方 gh_ref は PR/issue picker でユーザーが明示的に紐づけた永続情報なので、
  /// terminal close を越えて保持し、worktree 削除で cascade 回収する。
  public var hasNonSessionIdentity: Bool {
    hasGhRef
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
