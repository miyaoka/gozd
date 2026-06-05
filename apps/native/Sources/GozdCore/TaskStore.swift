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
// 3. **SessionEnd hook / terminal close**: task.sessionID を保持する。
//    task 本体も削除しない (ghRef 有無に関わらず)。代わりに `closed_by_user=true` を
//    立て、サイドバー上の状態表示を `resumable` → `closed` に切り替えるシグナルとする。
//    削除はユーザーが明示的に行う (worktree 削除 cascade or task の ⋮ メニュー)。
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

  /// 指定 worktree dir で resume 可能な Claude セッションの session_id 一覧を返す。
  /// renderer の visit() が未訪問 worktree の初回オープン時に呼ぶ自動復元集合。
  /// `worktreeDir == dir && sessionID 非空 && !closedByUser` を満たす task を集める
  /// (app close で中断され closedByUser=false のまま残ったもの)。
  /// `list` は projectKey 単位で全 worktree の task を返すため worktreeDir 一致で絞る
  /// (絞り漏れると別 worktree の session を resume してしまう)。
  public func resumableSessionIds(dir: String) throws -> [String] {
    return try list(dir: dir)
      .filter { $0.worktreeDir == dir && !$0.sessionID.isEmpty && !$0.closedByUser }
      .map { $0.sessionID }
  }

  /// Task を作成または再活性化する。PR/issue picker から呼ばれる経路 + Claude 直接起動の
  /// SessionStart hook fallback (`attachSession` 内部) から呼ばれる経路がある。
  ///
  /// 動作:
  ///   - `ghRef` 指定があり、同 `worktreeDir` + 同 `ghRef` の既存 task が見つかれば
  ///     **upsert**: `gh_title` を最新の PR/issue タイトルで上書きし、
  ///     `closed_by_user=false` に倒して返す。`user_title` はユーザー編集の確定値
  ///     なので触らない (本関数からはそもそも書き込み経路を持たない)。createdAt / id /
  ///     sessionID / terminalTitle / userTitle は保持される。
  ///   - それ以外は新規 task を UUID で作成。新規 task の user_title は空 (編集 dialog
  ///     で `setUserTitle` 経由でしか設定されない契約)。`createdAt` を省略すると現在時刻。
  ///
  /// `user_title` 書き込み経路は意図的にこの関数から外している (`setUserTitle` 専用)。
  /// silent drop を避けるための物理分離。
  public func add(
    dir: String, ghTitle: String, worktreeDir: String,
    ghRef: Gozd_V1_GhRef?, createdAt: String? = nil
  ) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    if let ghRef,
      let idx = list.tasks.firstIndex(where: {
        $0.worktreeDir == worktreeDir && $0.hasGhRef && $0.ghRef == ghRef
      })
    {
      list.tasks[idx].ghTitle = ghTitle
      list.tasks[idx].closedByUser = false
      try saveFile(list, for: dir)
      return list.tasks[idx]
    }
    var task = Gozd_V1_Task()
    task.id = UUID().uuidString
    task.ghTitle = ghTitle
    task.worktreeDir = worktreeDir
    if let ghRef { task.ghRef = ghRef }
    task.createdAt = createdAt ?? ISO8601DateFormatter().string(from: Date())
    list.tasks.append(task)
    try saveFile(list, for: dir)
    return task
  }

  /// OSC ターミナルタイトル経由で観測した値を Task に書き込む。renderer 側 useSidebarData
  /// から呼ばれる。user_title が空のときの表示フォールバックに使う観測値。
  public func setTerminalTitle(dir: String, id: String, terminalTitle: String) throws
    -> Gozd_V1_Task
  {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].terminalTitle = terminalTitle
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  /// 編集 dialog からのユーザー明示タイトル設定 (新規タイトル / クリア両用)。
  /// 空文字を渡すと user_title をクリアし、表示は gh_title / terminal_title の
  /// 自然なフォールバックチェーンに戻る (= reset 経路)。
  public func setUserTitle(dir: String, id: String, userTitle: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].userTitle = userTitle
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  /// ⋮ メニューからの明示削除。worktree 削除 cascade と並ぶ唯一のユーザー操作削除経路。
  /// root worktree のように `git worktree remove` で消えない場所の task や、
  /// `closed_by_user` で滞留した task を片付けるために使う。
  public func remove(dir: String, id: String) throws {
    var list = try loadFile(for: dir)
    list.tasks.removeAll { $0.id == id }
    try saveFile(list, for: dir)
  }

  /// Claude session-start hook を Task に attach する。
  ///
  /// 優先順位:
  ///   1. 既に sessionID が一致する task → 同一セッションの継続 (resume) が確定して
  ///      いる経路。`closed_by_user` が true なら false に倒して「生きている」状態に
  ///      戻す。
  ///   2. 同一 worktreeDir の `sessionID == ""` candidate に新 sid を attach。
  ///      candidate は sessionID 空の task のみ (PR/issue picker 由来の未起動 task、
  ///      resume 失敗で sid を空に戻された task)。pick は createdAt 最大値 (= 最新)、
  ///      tie-break は id 辞書順で最大値。closed_by_user=true でも sessionID が空なら
  ///      candidate に含め、pick 時に false へ倒す。
  ///      **closed だが sessionID を保持する (= resume 可能な) task は candidate にしない。**
  ///      新しい session_id は必ず別 task になる (session ≒ task の 1:1。`/clear` で
  ///      session_id が変わったら新 task。既存 task の sid を別 session が奪う hijack は
  ///      しない)。累積した closed task はユーザーが ⋮ メニュー or worktree 削除 cascade
  ///      で消す。
  ///   3. 該当無し → 新規 task を作成し sessionID を入れる (Claude 直接起動経路)。
  public func attachSession(dir: String, sessionId: String, worktreeDir: String) throws {
    var list = try loadFile(for: dir)
    if let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) {
      if list.tasks[idx].closedByUser {
        list.tasks[idx].closedByUser = false
        try saveFile(list, for: dir)
      }
      return
    }
    let candidates = list.tasks.enumerated().filter {
      $0.element.worktreeDir == worktreeDir && $0.element.sessionID.isEmpty
    }
    // 1次キー: createdAt の最大値を pick (= 最新)。
    // 2次キー: id (UUID) の最大値を pick (辞書順で末尾)。createdAt は ISO 8601 秒粒度
    // なので 1 秒以内に複数 task を作ると同値になる。tie-break を入れないと max(by:) の
    // 入力順序依存で非決定的になる。`<` 比較は max(by:) に渡す述語で「strict less」を
    // 表すための既定形 (Swift 標準ライブラリ規約)。
    if let pick = candidates.max(by: { a, b in
      if a.element.createdAt != b.element.createdAt {
        return a.element.createdAt < b.element.createdAt
      }
      return a.element.id < b.element.id
    }) {
      list.tasks[pick.offset].sessionID = sessionId
      if list.tasks[pick.offset].closedByUser {
        list.tasks[pick.offset].closedByUser = false
      }
    } else {
      var task = Gozd_V1_Task()
      task.id = UUID().uuidString
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
  ///   - task 本体は **削除しない** (ghRef 有無に関わらず)。
  ///   - `sessionID` を保持する。次回 `claude --resume` の起点に使う。
  ///   - `closed_by_user=true` を立てる。サイドバー UI 上で `closed` 状態として
  ///     表示し、`resumable` (app close 由来の中断) と区別する。
  ///
  /// app close (renderer 強制終了) ではこの関数は呼ばれないため、`closed_by_user`
  /// は false のままで残り、サイドバーには `resumable` 表示が出る。
  public func detachSession(dir: String, sessionId: String) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    list.tasks[idx].closedByUser = true
    try saveFile(list, for: dir)
  }

  /// resume 失敗検出経路 (claude --resume が transcript 不在等で error 終了) で呼ぶ。
  ///
  /// 動作:
  ///   - task 本体は削除せず、`sessionID` だけ空にする。次のクリックで `--resume`
  ///     ではなく素の `claude` 起動経路へ流すための書き換え。
  ///   - `markClosedByUser=true` (removeByPty 経路: terminal close で resume 失敗 +
  ///     SessionStart hook 不達): `closed_by_user=true` も立てる。ユーザーが
  ///     pane を閉じた事実をシグナル化する。
  ///   - `markClosedByUser=false` (session-start fallback 経路: resume 失敗後に
  ///     新 sid が立ち上がったケース): `closed_by_user` は据え置き。直後の
  ///     `attachSession(新 sid)` が候補ピック経路で同一 task に転移する。
  public func clearDeadSession(
    dir: String, sessionId: String, markClosedByUser: Bool
  ) throws {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.sessionID == sessionId }) else {
      return
    }
    list.tasks[idx].sessionID = ""
    if markClosedByUser {
      list.tasks[idx].closedByUser = true
    }
    try saveFile(list, for: dir)
  }

  /// worktree 物理削除 (handleWorktreeRemove) からの連動掃除。
  /// 該当 worktreeDir に紐づく全 Task を削除し、worktree 削除後に Task が
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
        StderrLog.write(
          tag: "TaskStore", "loadFile: parse failed at \(url.path): \(error)")
      }
    } else {
      StderrLog.write(tag: "TaskStore", "loadFile: invalid UTF-8 at \(url.path)")
    }
    let empty = Gozd_V1_TaskList()
    try saveFile(empty, for: dir)
    StderrLog.write(
      tag: "TaskStore", "loadFile: corrupted tasks.json reinitialized at \(url.path)")
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
