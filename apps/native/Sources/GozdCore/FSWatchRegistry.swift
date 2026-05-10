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
//    - `<dir>/.git/worktrees/...` 配下 → `worktreeChange`
//    - `<dir>/.git/refs/heads/...` または `<dir>/.git/packed-refs` → `branchChange`
//    - `<dir>/.git/index` または `<dir>/.git/HEAD` → `gitStatusChange`
//    - その他作業ツリー（`<dir>/.git/` 配下以外） → `fsChange` + `gitStatusChange`
//      （未追跡ファイルや作業ツリー差分も status に影響するため）
//
// 3. **debounce**。FSEvents は数十 ms 以内に同一バッチを連続 dispatch する。
//    1 バッチを 1 つの push にまとめるため、Task の実行内でフラグ管理する。
//
// 4. **push の重複は許容**。renderer 側は冪等な再 fetch（onMessage の handler）
//    で受け止めるので、`fsChange` と `gitStatusChange` を両方出しても問題ない。
public actor FSWatchRegistry {
  public typealias FsChangeHandler = @Sendable (_ dir: String, _ relDir: String) -> Void
  public typealias GitStatusChangeHandler = @Sendable (_ dir: String, _ status: GitOps.StatusFull)
    -> Void
  public typealias BranchChangeHandler = @Sendable (_ dir: String) -> Void
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
  }

  private struct Classification {
    let fsRelDirs: Set<String>
    let hasFsChange: Bool
    let hasGitStatusChange: Bool
    let hasBranchChange: Bool
    let hasWorktreeChange: Bool
  }

  private let onFsChange: FsChangeHandler
  private let onGitStatusChange: GitStatusChangeHandler
  private let onBranchChange: BranchChangeHandler
  private let onWorktreeChange: WorktreeChangeHandler
  private var entries: [String: Entry] = [:]
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
  public func watch(dir userDir: String) throws {
    let dir = FSWatchRegistry.realpath(userDir)
    if entries[dir] != nil { return }

    nextGeneration += 1
    let generation = nextGeneration

    let (stream, continuation) = AsyncStream<[FSWatcher.Event]>.makeStream()
    let watcher = FSWatcher(paths: [dir])
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
      originalDir: userDir)
  }

  /// dir の監視を停止する。watch されていなければ no-op。
  public func unwatch(dir userDir: String) {
    let dir = FSWatchRegistry.realpath(userDir)
    guard let entry = entries.removeValue(forKey: dir) else { return }
    entry.watcher.stop()
    entry.continuation.finish()
    entry.task.cancel()
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
    guard let originalDir = entries[dir]?.originalDir else { return }

    let result = FSWatchRegistry.classify(dir: dir, events: events)

    // 分類は同期処理なので await を挟まないが、明示的に再 check しておく。
    guard isActive(dir: dir, generation: generation) else { return }

    if result.hasFsChange {
      for relDir in result.fsRelDirs {
        onFsChange(originalDir, relDir)
      }
    }
    if result.hasBranchChange {
      onBranchChange(originalDir)
    }
    if result.hasWorktreeChange {
      onWorktreeChange(originalDir)
    }

    if result.hasGitStatusChange {
      let status = try? await GitOps.gitStatusFull(dir: dir)
      // gitStatusFull の await 中に unwatch されている可能性があるため再 check
      guard isActive(dir: dir, generation: generation), let status else { return }
      onGitStatusChange(originalDir, status)
    }
  }

  public func isWatching(dir userDir: String) -> Bool {
    entries[FSWatchRegistry.realpath(userDir)] != nil
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
  private static func classify(dir: String, events: [FSWatcher.Event]) -> Classification {
    let dirWithSlash = dir.hasSuffix("/") ? dir : dir + "/"
    let gitPrefix = dirWithSlash + ".git/"

    var fsRelDirs = Set<String>()
    var hasFsChange = false
    var hasGitStatusChange = false
    var hasBranchChange = false
    var hasWorktreeChange = false

    for event in events {
      let path = event.path
      // FSEvents の path は physical realpath。dir 配下でなければ無視。
      guard path == dir || path.hasPrefix(dirWithSlash) else { continue }

      if path.hasPrefix(gitPrefix) {
        let rel = String(path.dropFirst(gitPrefix.count))
        if rel.hasPrefix("worktrees/") {
          hasWorktreeChange = true
        } else if rel.hasPrefix("refs/heads/") || rel == "packed-refs" {
          hasBranchChange = true
        } else if rel == "index" || rel == "HEAD" {
          hasGitStatusChange = true
        }
        // それ以外の .git 配下（objects/, logs/ 等）は無視
      } else {
        // 作業ツリー側の変更 → fsChange + gitStatusChange
        hasFsChange = true
        hasGitStatusChange = true
        let relDir = relativeDir(path: path, dir: dir, dirWithSlash: dirWithSlash)
        fsRelDirs.insert(relDir)
      }
    }

    return Classification(
      fsRelDirs: fsRelDirs,
      hasFsChange: hasFsChange,
      hasGitStatusChange: hasGitStatusChange,
      hasBranchChange: hasBranchChange,
      hasWorktreeChange: hasWorktreeChange
    )
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
