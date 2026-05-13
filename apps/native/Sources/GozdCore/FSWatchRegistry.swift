import Foundation

// dir 単位で FSWatcher を保持し、再帰的なファイル変更を 4 種類の push event に
// 振り分ける actor。
//
// 設計判断:
//
// 1. **dir をキーにした 1 watcher 1 dir**。worktree ごとに renderer から
//    `/fs/watch` で登録され、worktree を閉じる時に `/fs/unwatch` で解除する。
//
// 2. **イベント分類**:
//    - per-worktree git dir 配下の `HEAD` / `index` → `gitStatusChange`
//    - common git dir 配下の `refs/heads/...` → `branchChange`
//    - common git dir 配下の `refs/remotes/...` → `gitStatusChange`
//      （`git push` 成功時にローカルの remote-tracking ref が書き換わる。
//      ahead/behind の更新を git-graph に伝えるための SSOT）
//    - common git dir 配下の `packed-refs` → `branchChange` + `gitStatusChange`
//      （pack 後はローカル ref と remote-tracking ref のどちらが書き換わったか
//      ファイル名だけでは判別できないため、両方を発火させる）
//    - common git dir 配下の `worktrees/...` → `worktreeChange`
//    - 作業ツリー側（git dir 配下以外） → `fsChange` + `gitStatusChange`
//      （未追跡ファイルや作業ツリー差分も status に影響するため）
//
//    worktree では `.git` がファイル参照で、commit / branch 更新の実体は親 repo の
//    `.git/worktrees/<name>/` と `.git/` に書かれる。FSEvents は登録 path 配下しか
//    監視しないため、worktree root だけ watch しても git 更新を取りこぼす。
//    そこで `git rev-parse --git-dir --git-common-dir` で 2 つの git dir を解決し、
//    FSWatcher の paths に追加する。通常 clone では両者が一致するので dedupe する。
//
// 3. **debounce**。FSEvents は数十 ms 以内に同一バッチを連続 dispatch する。
//    1 バッチを 1 つの push にまとめるため、Task の実行内でフラグ管理する。
//
// 4. **push の重複は許容**。renderer 側は冪等な再 fetch（onMessage の handler）
//    で受け止めるので、`fsChange` と `gitStatusChange` を両方出しても問題ない。
//
// 5. **SSOT push + 低頻度 pull の二重防御**。FSEvents は push 経路だが、watch 開始
//    往復中の取りこぼしや、`callJavaScript` の失敗で 1 度落とすと UI 状態が永続
//    的にずれる。renderer 側で 2 つの保険を組んでいる:
//    - `rpcFsWatch` 応答直後の `fsWatchReady` 再同期トリガー（watch 起動瞬間 1 回）
//    - 60 秒間隔の `rpcGitRefsDigest` 整合性チェック（push 不達を検知して `loadLog`）
//    どちらも「予防 retry」ではなく観察可能性の補強。不一致を検知したら必ず
//    `console.warn` でログを残し、symptom を silent fix しない。
public actor FSWatchRegistry {
  public typealias FsChangeHandler = @Sendable (_ dir: String, _ relDir: String) -> Void
  public typealias GitStatusChangeHandler = @Sendable (_ dir: String, _ status: GitOps.StatusFull)
    -> Void
  /// branchChange ハンドラ。`changedRefs` には今回のバッチで動いた refs/heads/ 配下の
  /// ref 名（`refs/heads/` を剥がした basename。例: `main`, `feat/foo`）を含める。
  /// `packed-refs` の更新で個別 ref を特定できない場合は空配列。
  /// 観察可能性のため、renderer 側がログ / バグ報告で利用できるよう payload に乗せる。
  public typealias BranchChangeHandler = @Sendable (_ dir: String, _ changedRefs: [String]) -> Void
  public typealias WorktreeChangeHandler = @Sendable (_ dir: String) -> Void

  private struct Entry {
    let generation: UInt64
    let watcher: FSWatcher
    let task: Task<Void, Never>
    let continuation: AsyncStream<[FSWatcher.Event]>.Continuation
    /// `/fs/watch` で renderer から渡された原文の dir。
    /// push event の payload はこの値を返し、renderer 側の `worktreeStore.dir` /
    /// `wt.path` 等の生文字列キーと直接比較できるようにする。
    /// （entries のキーは `realpath` 解決済み path で、FSEvents の path 比較に使う）
    let originalDir: String
    /// `git rev-parse --git-dir` の realpath。dir が git repo でない時のみ nil。
    let perWorktreeGitDir: String?
    /// `git rev-parse --git-common-dir` の realpath。dir が git repo でない時のみ nil。
    /// 通常 clone では `perWorktreeGitDir` と一致する。
    let commonGitDir: String?
  }

  // 分岐網羅テスト容易性のため internal で公開する。dispatch は actor 内で完結するため
  // この struct を外部から直接組み立てる用途は無い。
  struct Classification: Equatable {
    let fsRelDirs: Set<String>
    let hasFsChange: Bool
    let hasGitStatusChange: Bool
    let hasBranchChange: Bool
    let hasWorktreeChange: Bool
    /// 今回のバッチで動いた refs/heads/ 配下の ref 名（`refs/heads/` を剥がした basename）。
    /// `packed-refs` の更新が含まれる場合は空のままで、個別 ref 特定は呼び出し側で諦める。
    let changedRefs: Set<String>
  }

  private let onFsChange: FsChangeHandler
  private let onGitStatusChange: GitStatusChangeHandler
  private let onBranchChange: BranchChangeHandler
  private let onWorktreeChange: WorktreeChangeHandler
  private var entries: [String: Entry] = [:]
  /// watch 時に renderer から渡された原文 dir → realpath 解決後のキー の逆引き。
  /// unwatch 時にディレクトリが既に削除されていると `realpath(3)` が失敗してフォールバックで
  /// 入力 path をそのまま返すため、watch 時のキーと一致せず entries が leak する。
  /// この逆引きを使えば「watch 時に解決した resolved key」で確実に削除できる。
  private var resolvedKeyByOriginalDir: [String: String] = [:]
  /// watch ごとに増える世代番号。unwatch 後に積まれていた stale event の dispatch を
  /// 抑止するため、event 配送前後に entries[dir]?.generation と一致するか check する。
  private var nextGeneration: UInt64 = 0

  public init(
    onFsChange: @escaping FsChangeHandler,
    onGitStatusChange: @escaping GitStatusChangeHandler,
    onBranchChange: @escaping BranchChangeHandler,
    onWorktreeChange: @escaping WorktreeChangeHandler
  ) {
    self.onFsChange = onFsChange
    self.onGitStatusChange = onGitStatusChange
    self.onBranchChange = onBranchChange
    self.onWorktreeChange = onWorktreeChange
  }

  /// dir の監視を開始する。既に watch されていれば no-op。
  /// 入力 dir は realpath 解決してキーに使う（FSEvents は realpath を返すため、
  /// `/var/...` と `/private/var/...` のような symlink の差を吸収する）。
  public func watch(dir userDir: String) async throws {
    let dir = FSWatchRegistry.realpath(userDir)
    if entries[dir] != nil {
      // 同一 resolved dir に複数 userDir で watch 要求が来ても、各 userDir → resolved の
      // 逆引きを残しておく（後続 unwatch が realpath 失敗で fallback した時に備える）。
      resolvedKeyByOriginalDir[userDir] = dir
      return
    }

    nextGeneration += 1
    let generation = nextGeneration

    // git dir を解決して FSWatcher の監視 path に追加する。
    // worktree では `.git` がファイル参照で、commit / branch 更新の実体は親 repo 側に
    // ある。worktree root だけ watch しても FSEvents が来ないため、両 git dir を
    // 監視対象に入れる必要がある。
    //
    // gitDirs は dir が git 管理下でない時のみ nil を返す（exit 128 を識別）。
    // それ以外の失敗（git バイナリ不在 / 出力破綻 / I/O 失敗）は throw して watch を中断
    // させる。ここで try? に握り潰すと「worktree なのに解決失敗」がサイレントに通常 watch
    // にフォールバックし、修正前と同じ症状（commit が反映されない）を再現してしまう。
    // realpath 解決後の dir を渡す。FSEvents の path 比較に使う path と一貫させる。
    let gitDirs = try await GitOps.gitDirs(dir: dir)
    let perWorktreeGitDir = gitDirs.map { FSWatchRegistry.realpath($0.perWorktreeGitDir) }
    let commonGitDir = gitDirs.map { FSWatchRegistry.realpath($0.commonGitDir) }

    var watchPaths = [dir]
    if let perWorktreeGitDir, !watchPaths.contains(perWorktreeGitDir) {
      watchPaths.append(perWorktreeGitDir)
    }
    if let commonGitDir, !watchPaths.contains(commonGitDir) {
      watchPaths.append(commonGitDir)
    }

    let (stream, continuation) = AsyncStream<[FSWatcher.Event]>.makeStream()
    let watcher = FSWatcher(paths: watchPaths)
    watcher.setHandler { events in
      continuation.yield(events)
    }
    try watcher.start()

    // event 配送は actor-isolated `handleEvents` 経由にする。stale event を
    // unwatch 後に dispatch しないよう、entries[dir]?.generation の一致を
    // dispatch 前後で check する設計（FSEvents 配信は async / 遅延配信があるため）。
    let task = Task { [weak self] in
      for await events in stream {
        await self?.handleEvents(dir: dir, generation: generation, events: events)
      }
    }

    entries[dir] = Entry(
      generation: generation, watcher: watcher, task: task, continuation: continuation,
      originalDir: userDir,
      perWorktreeGitDir: perWorktreeGitDir,
      commonGitDir: commonGitDir)
    resolvedKeyByOriginalDir[userDir] = dir
  }

  /// dir の監視を停止する。watch されていなければ no-op。
  /// 削除済みパスでは `realpath(3)` がフォールバックで入力 path を返すため、
  /// watch 時に保存した逆引きを優先してキーを引く（leak 防止）。
  ///
  /// **セマンティクス**: 同一 resolved dir に複数 userDir で watch が重ねられて
  /// いた場合、いずれか 1 つの userDir で unwatch を呼ぶと entry 自体が解放され、
  /// 残りの全 userDir 逆引きも一括で invalidate される。つまり「`watch` は冪等で
  /// 逆引きを増やすだけ、`unwatch` は全 userDir 参照を巻き取って 1 度で解放」。
  /// renderer 側で 1 worktree に対して複数 userDir で watch を投げる前提は無いため、
  /// この簡略セマンティクスで十分（参照カウントは持たない）。
  public func unwatch(dir userDir: String) {
    let resolvedKey = resolvedKeyByOriginalDir.removeValue(forKey: userDir)
      ?? FSWatchRegistry.realpath(userDir)
    guard let entry = entries.removeValue(forKey: resolvedKey) else { return }
    entry.watcher.stop()
    entry.continuation.finish()
    entry.task.cancel()
    // 同一 resolved dir を指していた他の userDir 逆引きも掃除する。
    // 同一 resolved に複数 userDir（symlink パスと非 symlink パスなど）で watch が
    // 重ねられた状態で、片方しか unwatch されないと逆引きエントリが leak するため。
    resolvedKeyByOriginalDir = resolvedKeyByOriginalDir.filter { $0.value != resolvedKey }
  }

  /// dispatch 時点で entry がまだ生きており、世代が一致するかを判定する。
  /// FSEvents の遅延配信や gitStatusFull の await 後に entry が消えていれば false。
  private func isActive(dir: String, generation: UInt64) -> Bool {
    entries[dir]?.generation == generation
  }

  /// 1 バッチの events を分類して push event として配送する。
  /// 各 await 後にも `isActive` を再 check し、unwatch 済みの世代からの dispatch を抑止する。
  ///
  /// push payload には `originalDir`（renderer が `/fs/watch` で渡した原文 dir）を使う。
  /// FSEvents の path 比較に使う `dir`（realpath 解決済み）とは別に保持しているのは、
  /// renderer 側の `worktreeStore.dir` / `wt.path` が生文字列で扱われるため、
  /// realpath を返すと symlink 経路（`/var` vs `/private/var` 等）で比較が外れるから。
  private func handleEvents(dir: String, generation: UInt64, events: [FSWatcher.Event]) async {
    guard isActive(dir: dir, generation: generation) else { return }
    guard let entry = entries[dir] else { return }
    let originalDir = entry.originalDir

    let result = FSWatchRegistry.classify(
      dir: dir,
      perWorktreeGitDir: entry.perWorktreeGitDir,
      commonGitDir: entry.commonGitDir,
      events: events)

    // 分類は同期処理なので await を挟まないが、明示的に再 check しておく。
    guard isActive(dir: dir, generation: generation) else { return }

    if result.hasFsChange {
      for relDir in result.fsRelDirs {
        onFsChange(originalDir, relDir)
      }
    }
    if result.hasBranchChange {
      onBranchChange(originalDir, Array(result.changedRefs).sorted())
    }
    if result.hasWorktreeChange {
      onWorktreeChange(originalDir)
    }

    if result.hasGitStatusChange {
      let status: GitOps.StatusFull
      do {
        status = try await GitOps.gitStatusFull(dir: dir)
      } catch {
        // 観察可能性のためログを残す。renderer は次の FSEvents バッチで再 fetch するため
        // 致命的ではないが、繰り返し発生していれば一時障害として診断したい。
        print("[FSWatchRegistry] gitStatusFull failed for \(dir): \(error)")
        return
      }
      // gitStatusFull の await 中に unwatch されている可能性があるため再 check
      guard isActive(dir: dir, generation: generation) else { return }
      onGitStatusChange(originalDir, status)
    }
  }

  public func isWatching(dir userDir: String) -> Bool {
    if let resolved = resolvedKeyByOriginalDir[userDir] {
      return entries[resolved] != nil
    }
    return entries[FSWatchRegistry.realpath(userDir)] != nil
  }

  /// POSIX `realpath(3)` で symlink を解決した絶対パスを返す。
  /// 解決失敗時は入力をそのまま返す（dir 不在等は呼び出し側で start エラーになる）。
  private static func realpath(_ path: String) -> String {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    return path.withCString { cstr in
      if let resolved = Darwin.realpath(cstr, &buf) {
        return String(cString: resolved)
      }
      return path
    }
  }

  /// 1 バッチの events を分類した結果を返す pure helper。dispatch は呼び出し側が行う。
  /// 分離理由: dispatch 前後に actor 上で世代 check を挟むため、副作用を持たない形にする。
  ///
  /// 判定優先順位:
  ///   1. per-worktree git dir 配下 → `HEAD` / `index` のみ `gitStatusChange`
  ///   2. common git dir 配下 →
  ///      - `refs/heads/...` を `branchChange`
  ///      - `refs/remotes/...` を `gitStatusChange`（push / fetch 後の ahead/behind 更新）
  ///      - `packed-refs` を `branchChange` + `gitStatusChange`（local / remote 両方を含み得るため）
  ///      - `worktrees/...` を `worktreeChange`
  ///   3. 作業ツリー配下（git dir 配下に該当しない場合）→ `fsChange` + `gitStatusChange`
  ///
  /// 意図的に未対応の ref 種別:
  ///   - `refs/tags/...`: タグ更新で git-graph 表示の即時反映が必要になった時点で
  ///     `gitStatusChange` 系か別 event（`tagChange` 等）を新設する。現状の git-graph は
  ///     タグを `git for-each-ref` で取得しており、`# branch.ab` の SSOT 哲学の射程外
  ///   - `refs/stash` / `refs/notes/...`: 現状の UI が表示していないため発火不要
  ///   これらは silent drop だが、将来 UI が表示する時に必ずここに分岐を足す
  ///
  /// 通常 clone では perWorktreeGitDir == commonGitDir なので 1 と 2 を両方適用する。
  /// その git dir は worktree root 配下に位置するため、3 のスキップも兼ねる。
  /// worktree clone では git dir が worktree root の外にあるため、3 では git dir を
  /// 自動的に通過しない。
  static func classify(
    dir: String,
    perWorktreeGitDir: String?,
    commonGitDir: String?,
    events: [FSWatcher.Event]
  ) -> Classification {
    let dirWithSlash = dir.hasSuffix("/") ? dir : dir + "/"

    var fsRelDirs = Set<String>()
    var hasFsChange = false
    var hasGitStatusChange = false
    var hasBranchChange = false
    var hasWorktreeChange = false
    var changedRefs = Set<String>()

    // 通常 clone では perWorktreeGitDir == commonGitDir なので、両ルールを同じ path に
    // 適用して `HEAD` と `refs/heads/` を両方拾う必要がある。
    // worktree clone では perWorktreeGitDir は commonGitDir の `worktrees/<name>/` 配下に
    // 物理的にネストする。`<common>/worktrees/<name>/HEAD` は per-wt 規則だけ適用すべきで、
    // common 規則の `worktrees/...` → worktreeChange を二重発火させると worktree list の
    // 変更と worktree-local な状態変化を混同する。
    let perWtSameAsCommon = perWorktreeGitDir == commonGitDir

    for event in events {
      let path = event.path
      var matchedGitDir = false

      let underPerWt = relativeUnder(path: path, root: perWorktreeGitDir)
      if let rel = underPerWt {
        matchedGitDir = true
        if rel == "HEAD" || rel == "index" {
          hasGitStatusChange = true
        }
        // それ以外（logs/, objects/, ORIG_HEAD 等）は無視
      }
      // per-wt と common が別 dir のとき、per-wt にマッチした path には common 規則を
      // 適用しない（per-wt の方が長い prefix で具体性が高いため、そちらが排他的に勝つ）。
      let applyCommonRule = perWtSameAsCommon || underPerWt == nil
      if applyCommonRule, let rel = relativeUnder(path: path, root: commonGitDir) {
        matchedGitDir = true
        if rel.hasPrefix("worktrees/") {
          hasWorktreeChange = true
        } else if rel.hasPrefix("refs/heads/") {
          hasBranchChange = true
          let refName = String(rel.dropFirst("refs/heads/".count))
          if !refName.isEmpty {
            changedRefs.insert(refName)
          }
        } else if rel.hasPrefix("refs/remotes/") {
          // push / fetch 成功でローカルの remote-tracking ref が書き換わる。
          // git-graph は gitStatusChange の `# branch.ab` で ahead/behind 更新を検知する。
          hasGitStatusChange = true
        } else if rel == "packed-refs" {
          // pack 後は loose ref がまとめられるが、ファイル名からは local ref と
          // remote-tracking ref のどちらが書き換わったか判別できない。
          // 両方の subscriber に通知する（worktree 一覧再取得 + ahead/behind 再取得）。
          hasBranchChange = true
          hasGitStatusChange = true
        }
      }

      if matchedGitDir { continue }

      // 作業ツリー側の変更 → fsChange + gitStatusChange
      guard path == dir || path.hasPrefix(dirWithSlash) else { continue }
      hasFsChange = true
      hasGitStatusChange = true
      let relDir = relativeDir(path: path, dir: dir, dirWithSlash: dirWithSlash)
      fsRelDirs.insert(relDir)
    }

    return Classification(
      fsRelDirs: fsRelDirs,
      hasFsChange: hasFsChange,
      hasGitStatusChange: hasGitStatusChange,
      hasBranchChange: hasBranchChange,
      hasWorktreeChange: hasWorktreeChange,
      changedRefs: changedRefs
    )
  }

  /// path が root 配下なら root からの相対パスを返す。配下でなければ nil。
  /// `path == root` のときは `""` を返す。
  private static func relativeUnder(path: String, root: String?) -> String? {
    guard let root else { return nil }
    if path == root { return "" }
    let rootWithSlash = root.hasSuffix("/") ? root : root + "/"
    guard path.hasPrefix(rootWithSlash) else { return nil }
    return String(path.dropFirst(rootWithSlash.count))
  }

  /// イベントの絶対 path から、dir に対する **親ディレクトリ** の相対パスを返す。
  /// `<dir>/foo/bar.txt` → `foo`。`<dir>/bar.txt` → `""`。
  /// renderer の `fsChange` payload は影響を受けたディレクトリ単位で更新するため、
  /// ファイル名は落としてディレクトリ部分のみ使う。
  private static func relativeDir(path: String, dir: String, dirWithSlash: String) -> String {
    let rel: String
    if path.hasPrefix(dirWithSlash) {
      rel = String(path.dropFirst(dirWithSlash.count))
    } else {
      rel = ""
    }
    if let lastSlash = rel.lastIndex(of: "/") {
      return String(rel[..<lastSlash])
    }
    return ""
  }

  // 明示的 deinit は省略する。actor の deinit は nonisolated 文脈になり、
  // non-Sendable な FSWatcher / Task / Continuation に触れない。
  // 各 entry が release されると:
  //   - FSWatcher.deinit が FSEventStream を Stop / Invalidate / Release する
  //   - AsyncStream.Continuation が drop されることで stream が自動 finish し、
  //     for-await の consumer Task も終了する
  // このため明示的後始末は不要。
}
