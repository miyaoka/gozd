import Foundation
import Testing

@testable import GozdCore

@Suite("FSWatchRegistry")
struct FSWatchRegistryTests {
  @Test("watch した dir 配下のファイル作成で fsChange handler が呼ばれる")
  func dispatchesFsChangeOnWorkTreeFile() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { dir, _ in collector.append("fsChange:\(dir)") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    let file = tmpDir.appendingPathComponent("hello.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)

    try await waitForEvent(
      collector, matching: { $0.hasPrefix("fsChange:") })
    let events = collector.snapshot()
    #expect(events.contains { $0.hasPrefix("fsChange:") })
  }

  @Test("git repo の `.git/refs/heads/...` 変更で branchChange が分類される")
  func classifiesBranchChange() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    let branchFile = tmpDir.appendingPathComponent(".git/refs/heads/feature-x")
    try "0123456789abcdef0123456789abcdef01234567\n"
      .write(to: branchFile, atomically: true, encoding: .utf8)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
  }

  @Test("worktree 内 commit で gitStatusChange が分類される（実体は親 repo の .git/worktrees/）")
  func classifiesGitStatusChangeForWorktreeCommit() async throws {
    let mainRepo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: mainRepo) }
    try await initGitRepo(at: mainRepo)

    // 初回 commit を作って HEAD を確立する。
    let seed = mainRepo.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: mainRepo)
    try await runGitCmd(["commit", "-m", "seed"], cwd: mainRepo)

    // worktree を分岐させる。
    let worktreeRoot = mainRepo.deletingLastPathComponent()
      .appendingPathComponent("wt-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: worktreeRoot) }
    try await runGitCmd(
      ["worktree", "add", "-b", "feature", worktreeRoot.path], cwd: mainRepo)
    let worktreeRootResolved = URL(fileURLWithPath: worktreeRoot.path).resolvingSymlinksInPath()

    // watch 開始前にファイル作成と add まで済ませる。watch 中の handleEvents は
    // `gitStatusFull` を spawn し、`git status` は read-only だが index stat refresh で
    // 同じ per-worktree git dir の `index.lock` を取りにいく場合がある。そこに `git add`
    // / `git commit` をぶつけると lock 競合で test が flake する。watch 中に撃つ git ops
    // は単一の `git commit` だけに絞り、gitStatusChange の発火経路を確実に踏ませる。
    let file = worktreeRootResolved.appendingPathComponent("a.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "a.txt"], cwd: worktreeRootResolved)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: worktreeRootResolved.path)
    try await Task.sleep(for: .milliseconds(300))
    collector.clear()

    try await runGitCmd(["commit", "-m", "add a"], cwd: worktreeRootResolved)

    try await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("gitStatusChange"))
  }

  @Test("`git branch -m` で current branch を改名すると branchChange と gitStatusChange が両方 dispatch される")
  func dispatchesBranchChangeAndStatusOnRename() async throws {
    // ユーザー報告の主因シナリオ: rename で commit OID は不変だが、HEAD が指す
    // branch 名が変わる。`git status --porcelain=v2 --branch` の `# branch.head`
    // の変化を SSOT として renderer に流すため、gitStatusChange も発火する必要がある。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)
    // 1 commit を作って HEAD を確立する（unborn branch だと branch -m は別経路）
    let seed = tmpDir.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "seed"], cwd: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))
    collector.clear()

    try await runGitCmd(["branch", "-m", "renamed-feature"], cwd: tmpDir)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    try await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
    #expect(events.contains("gitStatusChange"))
  }

  @Test("`git pack-refs --all` で packed-refs が更新されると branchChange + gitStatusChange が dispatch される")
  func dispatchesOnPackRefs() async throws {
    // pack 後はファイル名から local / remote のどちらが pack されたか判別不能なため、
    // 両方の subscriber に通知する設計。pack 自体はテスト時に 0 loose ref でも実行可能。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)
    // 1 commit + branch を作って pack 対象を確保する
    let seed = tmpDir.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "seed"], cwd: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))
    collector.clear()

    try await runGitCmd(["pack-refs", "--all"], cwd: tmpDir)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    try await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
    #expect(events.contains("gitStatusChange"))
  }

  @Test("同一 dir を再 watch すると古い entry を破棄して再構築する（idempotent re-entry 契約）")
  func watchRebuildsExistingEntry() async throws {
    // P 指摘の根本対応テスト: 旧 entry no-op 返しでは perWorktreeGitDir / commonGitDir の
    // 解決値が永続的に古いまま残るバグがあった。再構築で新しい gitDirs 解決が反映され、
    // かつイベント受信が継続することを確認する。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    // 2 回目の watch（同 dir）— 旧設計の no-op ではなく再構築されることを担保する。
    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))
    collector.clear()

    // 再構築後も branch ref の変更が dispatch される（= 新 entry が live で動いている）
    let branchFile = tmpDir.appendingPathComponent(".git/refs/heads/feature-rebuilt")
    try "0123456789abcdef0123456789abcdef01234567\n"
      .write(to: branchFile, atomically: true, encoding: .utf8)

    try await waitForEvent(collector, matching: { $0 == "branchChange" })
    #expect(collector.snapshot().contains("branchChange"))
  }

  @Test("unwatchAll は全 entry を破棄して破棄件数を返し、以降イベントが届かない")
  func unwatchAllRemovesEveryEntry() async throws {
    // renderer の `onUnmounted` から 1 度の RPC で呼ばれる経路。N 個並列の `unwatch`
    // 発射に対する観察可能性つき集約 cleanup として `FSWatchRegistry.unwatchAll()` を
    // 守る regression test。返り値 (件数) と「以降 event が dispatch されない」の
    // 両方を verify する。
    let dirA = try makeTempDir()
    let dirB = try makeTempDir()
    defer {
      try? FileManager.default.removeItem(at: dirA)
      try? FileManager.default.removeItem(at: dirB)
    }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: dirA.path)
    try await registry.watch(dir: dirB.path)
    try await Task.sleep(for: .milliseconds(300))

    // 2 entry watched → unwatchAll で 2 を返す
    let count = await registry.unwatchAll()
    #expect(count == 2)
    #expect(await registry.isWatching(dir: dirA.path) == false)
    #expect(await registry.isWatching(dir: dirB.path) == false)
    collector.clear()

    // unwatchAll 後の file 作成は dispatch されない
    let fileA = dirA.appendingPathComponent("after-unwatch-a.txt")
    let fileB = dirB.appendingPathComponent("after-unwatch-b.txt")
    try "x".write(to: fileA, atomically: true, encoding: .utf8)
    try "x".write(to: fileB, atomically: true, encoding: .utf8)

    try await Task.sleep(for: .milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }

  @Test("entries 空での unwatchAll は 0 件返して no-op")
  func unwatchAllWithNoEntriesReturnsZero() async throws {
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, _ in },
      onBranchChange: { _, _ in },
      onWorktreeChange: { _ in }
    )
    let count = await registry.unwatchAll()
    #expect(count == 0)
  }

  @Test("unwatch 後はイベントが届かない")
  func unwatchStopsDispatch() async throws {
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _, _ in collector.append("branchChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await Task.sleep(for: .milliseconds(300))

    // unwatch を actor 上で処理させた後に collector を clear する。
    // unwatch 前に clear すると、watch 開始直後の latent event が clear と unwatch の
    // 間に配送される余地が残るため、テストの主旨（「unwatch 以降の変更で dispatch が
    // 走らない」）から外れた失敗が起きうる。
    await registry.unwatch(dir: tmpDir.path)
    collector.clear()

    let file = tmpDir.appendingPathComponent("after-unwatch.txt")
    try "x".write(to: file, atomically: true, encoding: .utf8)

    try await Task.sleep(for: .milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }
}

// MARK: - classify pure unit tests

@Suite("FSWatchRegistry.classify")
struct ClassifyTests {
  // 共通の Event 生成 helper。flags / id は分類に影響しないので 0 固定。
  private func ev(_ path: String) -> FSWatcher.Event {
    FSWatcher.Event(path: path, flags: 0, id: 0)
  }

  /// classify pure unit tests 用の path 生成。`URL(fileURLWithPath:)` + `appendingPathComponent`
  /// で組み立てて `.path` を返す。リテラル `/` 区切りを直書きせず、CLAUDE.md の
  /// 「Swift 側のパス処理は `URL` / `FileManager` を使い、リテラル区切り `/` をハードコード
  /// しない」規約に揃える。テストは synthetic な path 文字列を `classify` に渡すだけだが、
  /// 規約は test fixture にも一貫して適用する。
  private func pathOf(_ components: String...) -> String {
    components.reduce(URL(fileURLWithPath: "/")) { url, component in
      url.appendingPathComponent(component)
    }.path
  }

  @Test("worktree 配置: per-worktree git dir 配下の HEAD は gitStatusChange のみ")
  func worktreePerWorktreeHead() {
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "worktrees", "foo", "HEAD"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の refs/heads/main は branchChange")
  func worktreeCommonBranchRef() {
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "heads", "main"))])
    #expect(result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の packed-refs は branchChange + gitStatusChange")
  func worktreeCommonPackedRefs() {
    // packed-refs は local ref と remote-tracking ref のどちらの pack かファイル名から
    // 判別不能なので両 subscriber に通知する。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "packed-refs"))])
    #expect(result.hasBranchChange)
    #expect(result.hasGitStatusChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: common git dir 配下の refs/remotes/origin/main は gitStatusChange")
  func worktreeCommonRemoteRef() {
    // git push / fetch 成功でローカルの remote-tracking ref が書き換わる。
    // git-graph の ahead/behind を更新するための gitStatusChange 経路。
    // worktree 一覧構造は変わらないため branchChange は発火させない。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "remotes", "origin", "main"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: refs/remotes/origin/HEAD（symbolic ref）も gitStatusChange")
  func worktreeCommonRemoteHeadSymRef() {
    // `origin/HEAD` は固定名の symbolic ref。`hasPrefix("refs/remotes/")` で同分岐に
    // 落ちる事を保証し、将来「branch 一覧変化」として再分類したくなった時の足場にする。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "remotes", "origin", "HEAD"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
  }

  @Test("worktree 配置: branch 名にスラッシュを含む refs/remotes/origin/feature/sub も gitStatusChange")
  func worktreeCommonRemoteRefNestedName() {
    // `feature/sub` のようなスラッシュ区切り branch 名。`hasPrefix` 判定なので通るはずだが、
    // 将来 `==` 等価判定にリグレッションした時に検知できるよう明示的に踏む。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "remotes", "origin", "feature", "sub"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
  }

  @Test("worktree 配置: refs/tags/ は意図的に silent drop（未対応 ref 種別）")
  func worktreeCommonTagsSilentDrop() {
    // 現状の git-graph はタグを `git for-each-ref` で取得しており、`# branch.ab` SSOT の
    // 射程外。タグ表示の即時反映が UI 要件になった時点でここに分岐を足す。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "tags", "v1.0.0"))])
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: 兄弟 worktree の worktrees/<other> 追加は worktreeChange")
  func worktreeCommonSiblingAdded() {
    // 自分の per-wt git dir は foo。兄弟 bar が追加されると `<common>/worktrees/bar/...` に
    // ファイルが生まれる。これは worktree list の変更なので worktreeChange を発火させる。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "worktrees", "bar", "HEAD"))])
    #expect(result.hasWorktreeChange)
    #expect(!result.hasGitStatusChange)
  }

  @Test("worktree 配置: 自身の per-wt 内部 (例: locked) は worktreeChange を発火させない")
  func worktreeCommonSelfInternalNotWorktreeChange() {
    // `<common>/worktrees/foo/locked` は per-wt git dir 配下なので per-wt 規則のみ適用。
    // worktree list の変更ではないため worktreeChange は出ない。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "worktrees", "foo", "locked"))])
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasGitStatusChange)  // locked は HEAD/index ではないので status も無し
  }

  @Test("worktree 配置: 作業ツリー配下のファイルは fsChange + gitStatusChange")
  func worktreeWorkTreeFile() {
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("wt", "foo", "src", "a.ts"))])
    #expect(result.hasFsChange)
    #expect(result.hasGitStatusChange)
    #expect(result.fsRelDirs == ["src"])
  }

  @Test("通常 clone: per-worktree == common == <dir>/.git でも HEAD と refs/heads が両方分類される")
  func normalCloneDualClassification() {
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [
        ev(pathOf("repo", ".git", "HEAD")),
        ev(pathOf("repo", ".git", "refs", "heads", "main")),
      ])
    #expect(result.hasGitStatusChange)
    #expect(result.hasBranchChange)
    // 通常 clone でも .git 配下は作業ツリー判定に乗せない
    #expect(!result.hasFsChange)
  }

  @Test("通常 clone: .git 配下の関心外ファイル（objects/）は何も発火させない")
  func normalCloneIgnoresObjects() {
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "objects", "ab", "cdef"))])
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("git dir nil（非 repo）: 作業ツリー配下のファイルは fsChange + gitStatusChange")
  func nonRepoFallsToWorkTreeBranch() {
    let dir = pathOf("somewhere")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: nil, commonGitDir: nil,
      events: [ev(pathOf("somewhere", "note.txt"))])
    #expect(result.hasFsChange)
    #expect(result.hasGitStatusChange)
  }

  @Test("refs/heads/<name> 変更で changedRefs に basename が含まれる")
  func changedRefsContainsBasename() {
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "refs", "heads", "main"))])
    #expect(result.hasBranchChange)
    #expect(result.changedRefs == ["main"])
  }

  @Test("refs/heads/<slash/contained> のスラッシュ含む branch 名も丸ごと changedRefs に入る")
  func changedRefsKeepsSlashes() {
    // `feat/foo` のような nested branch 名は `refs/heads/feat/foo` で表現される。
    // basename を取るときに最初の `/` で切ってしまわないか保証する。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "refs", "heads", "feat", "foo"))])
    #expect(result.hasBranchChange)
    #expect(result.changedRefs == ["feat/foo"])
  }

  @Test("複数の refs/heads/ event は changedRefs に全部入る")
  func changedRefsMergesMultiple() {
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [
        ev(pathOf("repo", ".git", "refs", "heads", "main")),
        ev(pathOf("repo", ".git", "refs", "heads", "feat", "sub")),
      ])
    #expect(result.hasBranchChange)
    #expect(result.changedRefs == ["main", "feat/sub"])
  }

  @Test("packed-refs だけの変更では個別 ref を特定できないため changedRefs は空")
  func packedRefsHasNoChangedRefs() {
    // packed-refs の中身はファイル名から判別不能。個別 ref 特定は呼び出し側で諦め、
    // changedRefs は空のままにする（branchChange は発火するが具体名は載せない）。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "packed-refs"))])
    #expect(result.hasBranchChange)
    #expect(result.hasGitStatusChange)
    #expect(result.changedRefs.isEmpty)
  }

  @Test("dir 配下でも git dir 配下でもない event は無視")
  func unrelatedPathIgnored() {
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("elsewhere", "x.txt"))])
    #expect(!result.hasFsChange)
    #expect(!result.hasGitStatusChange)
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fswatchregistry-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
}

private struct GitCmdError: Error, CustomStringConvertible {
  let args: [String]
  let exitCode: Int32
  let stderr: String
  var description: String {
    "git \(args.joined(separator: " ")) failed (exit \(exitCode)): \(stderr)"
  }
}

private func runGitCmd(_ args: [String], cwd: URL) async throws {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  p.arguments = ["git"] + args
  p.currentDirectoryURL = cwd
  // テスト用 commit のために identity を上書きする。
  var env = ProcessInfo.processInfo.environment
  env["GIT_AUTHOR_NAME"] = "test"
  env["GIT_AUTHOR_EMAIL"] = "test@example.com"
  env["GIT_COMMITTER_NAME"] = "test"
  env["GIT_COMMITTER_EMAIL"] = "test@example.com"
  p.environment = env
  let stderrPipe = Pipe()
  p.standardOutput = Pipe()
  p.standardError = stderrPipe
  try p.run()
  p.waitUntilExit()
  if p.terminationStatus != 0 {
    let stderr = String(
      decoding: stderrPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    throw GitCmdError(args: args, exitCode: p.terminationStatus, stderr: stderr)
  }
}

private func initGitRepo(at dir: URL) async throws {
  try await runGitCmd(["init", "-q", "-b", "main"], cwd: dir)
}

private struct EventTimeout: Error, CustomStringConvertible {
  let timeout: Duration
  let observed: [String]
  var description: String {
    "waitForEvent timed out after \(timeout). Observed events: \(observed)"
  }
}

private func waitForEvent(
  _ collector: EventNameCollector,
  timeout: Duration = .seconds(2),
  matching predicate: @escaping (String) -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if collector.snapshot().contains(where: predicate) { return }
    try await Task.sleep(for: .milliseconds(50))
  }
  // タイムアウトを silent return せず throw する。「期待イベントが届かなかった」のか
  // 「タイムアウトで打ち切った」のかを呼び出し側が区別できるようにする。
  throw EventTimeout(timeout: timeout, observed: collector.snapshot())
}

private final class EventNameCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []

  func append(_ name: String) {
    lock.lock()
    defer { lock.unlock() }
    events.append(name)
  }

  func snapshot() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    events.removeAll()
  }
}
