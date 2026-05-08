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
    let watcher: FSWatcher
    let task: Task<Void, Never>
    let continuation: AsyncStream<[FSWatcher.Event]>.Continuation
  }

  private let onFsChange: FsChangeHandler
  private let onGitStatusChange: GitStatusChangeHandler
  private let onBranchChange: BranchChangeHandler
  private let onWorktreeChange: WorktreeChangeHandler
  private var entries: [String: Entry] = [:]

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

    let (stream, continuation) = AsyncStream<[FSWatcher.Event]>.makeStream()
    let watcher = FSWatcher(paths: [dir])
    watcher.setHandler { events in
      continuation.yield(events)
    }
    try watcher.start()

    let onFsChange = self.onFsChange
    let onGitStatusChange = self.onGitStatusChange
    let onBranchChange = self.onBranchChange
    let onWorktreeChange = self.onWorktreeChange

    let task = Task.detached {
      for await events in stream {
        FSWatchRegistry.classifyAndDispatch(
          dir: dir,
          events: events,
          onFsChange: onFsChange,
          onGitStatusChange: onGitStatusChange,
          onBranchChange: onBranchChange,
          onWorktreeChange: onWorktreeChange
        )
      }
    }

    entries[dir] = Entry(watcher: watcher, task: task, continuation: continuation)
  }

  /// dir の監視を停止する。watch されていなければ no-op。
  public func unwatch(dir userDir: String) {
    let dir = FSWatchRegistry.realpath(userDir)
    guard let entry = entries.removeValue(forKey: dir) else { return }
    entry.watcher.stop()
    entry.continuation.finish()
    entry.task.cancel()
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

  /// 1 バッチの events を分類して push event として配送する。
  /// detached Task からの呼び出しで actor isolation を保つため static にする。
  private static func classifyAndDispatch(
    dir: String,
    events: [FSWatcher.Event],
    onFsChange: @escaping FsChangeHandler,
    onGitStatusChange: @escaping GitStatusChangeHandler,
    onBranchChange: @escaping BranchChangeHandler,
    onWorktreeChange: @escaping WorktreeChangeHandler
  ) {
    let dirWithSlash = dir.hasSuffix("/") ? dir : dir + "/"
    let gitPrefix = dirWithSlash + ".git/"

    var fsRelDirs = Set<String>()
    var hasWorkTreeChange = false
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
        hasWorkTreeChange = true
        hasGitStatusChange = true
        let relDir = relativeDir(path: path, dir: dir, dirWithSlash: dirWithSlash)
        fsRelDirs.insert(relDir)
      }
    }

    if hasWorkTreeChange {
      for relDir in fsRelDirs {
        onFsChange(dir, relDir)
      }
    }
    if hasGitStatusChange {
      Task {
        if let status = try? await GitOps.gitStatusFull(dir: dir) {
          onGitStatusChange(dir, status)
        }
      }
    }
    if hasBranchChange {
      onBranchChange(dir)
    }
    if hasWorktreeChange {
      onWorktreeChange(dir)
    }
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
