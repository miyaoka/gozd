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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    let file = tmpDir.appendingPathComponent("hello.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)

    await waitForEvent(
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    let branchFile = tmpDir.appendingPathComponent(".git/refs/heads/feature-x")
    try "0123456789abcdef0123456789abcdef01234567\n"
      .write(to: branchFile, atomically: true, encoding: .utf8)

    await waitForEvent(collector, matching: { $0 == "branchChange" })
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: worktreeRootResolved.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    try await runGitCmd(["commit", "-m", "add a"], cwd: worktreeRootResolved)

    await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("gitStatusChange"))
  }

  @Test("gitignore 対象ファイルの連続書き込みは StatusFull が不変なので gitStatusChange を 1 回しか push しない")
  func dedupsGitStatusChangeForUnchangedStatus() async throws {
    // typecheck / ビルドが gitignore 対象（`.tsbuildinfo` / `dist` / `node_modules`）を
    // 連続書き込みするケースの regression guard。これらは作業ツリー event として
    // gitStatusChange に分類されるが git status 出力には現れず StatusFull が不変になる。
    // dedup が無いと renderer 側の参照差し替えで changes / filer ビューが再描画され続ける。
    let repo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: repo) }
    try await initGitRepo(at: repo)

    // `.gitignore` で `*.log` を除外し、commit して clean working tree を確立する。
    try "*.log\n".write(
      to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
    try await runGitCmd(["add", ".gitignore"], cwd: repo)
    try await runGitCmd(["commit", "-m", "seed"], cwd: repo)

    // a.log / b.log を別サブディレクトリに置き、fsChange payload の relDir（dir-a / dir-b）で
    // 由来を区別できるようにする。サブディレクトリは watch 開始前に作り、作成由来の fsChange を
    // 発火させない。書き込みは atomically: false にして temp 作成 + rename を避ける（temp が
    // 一時的に untracked ファイルとして git status を汚す経路と、1 write が複数 batch に割れる
    // 経路の両方を断つ）。
    let dirA = repo.appendingPathComponent("dir-a")
    let dirB = repo.appendingPathComponent("dir-b")
    try FileManager.default.createDirectory(at: dirA, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: dirB, withIntermediateDirectories: true)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, relDir in collector.append("fs:\(relDir)") },
      // status の中身で clean（statuses 空）/ dirty を区別する。dedup は内容一致（clean ==
      // clean）のときだけ起きるので、この区別が dedup の検証軸になる。
      onGitStatusChange: { _, status in
        collector.append(status.statuses.isEmpty ? "git:clean" : "git:dirty")
      },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: repo.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    // 1 回目: cache 空なので clean status が push される（git:clean #1、cache = clean）。
    try "a".write(
      to: dirA.appendingPathComponent("a.log"), atomically: false, encoding: .utf8)
    await waitForEvent(collector, matching: { $0 == "git:clean" })

    // 2 回目: ignore 対象なので status は clean のまま = 内容一致で dedup され push されない。
    // b.log の batch が dispatch されたことを relDir == "dir-b" の fsChange で待つ。さらに
    // status の trailing-debounce 窓 (statusDebounceMs=150ms) + gitStatusFull の実行時間を超える
    // settle を挟み、b.log の status 評価 (clean → dedup) を c.txt より前に確実に発火させる
    // (issue #809 で gitStatusFull は直列 await から debounce タスクへ移行。settle を挟まないと
    // b.log の debounce タスクが c.txt の schedule にキャンセルされ、同一窓に畳まれて b.log 単独の
    // dedup を検証できない)。
    try "b".write(
      to: dirB.appendingPathComponent("b.log"), atomically: false, encoding: .utf8)
    await waitForEvent(collector, matching: { $0 == "fs:dir-b" })
    await sleepThreaded(.milliseconds(400))

    // 3 回目: ignore されない c.txt を作る。status が dirty（?? c.txt）に変わるので dedup されず
    // git:dirty が push される。b.log の status 評価は上の settle で確定済みのため、git:dirty
    // 到達時点で b.log の dedup 判定は観測可能。
    try "c".write(
      to: repo.appendingPathComponent("c.txt"), atomically: false, encoding: .utf8)
    await waitForEvent(collector, matching: { $0 == "git:dirty" })

    // b.log が dedup されていれば git:clean は a.log の 1 回のみ。dedup が壊れていれば b.log が
    // 2 回目の git:clean を push して 2 になる。
    let events = collector.snapshot()
    #expect(events.filter { $0 == "git:clean" }.count == 1)
    #expect(events.contains("git:dirty"))
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    try await runGitCmd(["branch", "-m", "renamed-feature"], cwd: tmpDir)

    await waitForEvent(collector, matching: { $0 == "branchChange" })
    await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
    #expect(events.contains("gitStatusChange"))
  }

  @Test("commit は heads digest を動かすので branchChange + gitStatusChange を撃つが、remotes 不変なので remoteRefsChange は撃たない (digest gating)")
  func commitFiresBranchNotRemoteByDigest() async throws {
    // reftable backend で commit が共有テーブルを書き換えても remote は動いていない。path 分類だけだと
    // remoteRefsChange を撃って `gh pr list` を連射するため、native 側で `git for-each-ref` の
    // 内容ダイジェストを取り、実際に動いたカテゴリ (heads / remotes) だけ dispatch する。本テストは
    // files backend だが gating は backend 非依存に効く。remote を持たない repo では remotes digest が
    // 常に空文字で、commit (heads 変化) では remoteRefsChange が立たないことを固定する。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)
    let seed = tmpDir.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "seed"], cwd: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    // digest baseline を確立する。branch 作成で branchChange 候補を 1 度踏ませ、その handleEvents で
    // refDigest が読まれ commonGitDir 単位に保存される。これをやらないと次の commit が「初回 digest
    // 計算 (prev == nil)」になり、初回無条件発火で remotes も撃たれて gating を検証できない。
    try await runGitCmd(["branch", "digest-baseline"], cwd: tmpDir)
    await waitForEvent(collector, matching: { $0 == "branchChange" })
    await sleepThreaded(.milliseconds(200))
    collector.clear()

    // 本命: 通常 commit。refs/heads/<current> の OID が進む (heads digest 変化) が remotes は不変。
    let file = tmpDir.appendingPathComponent("a.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "a.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "add a"], cwd: tmpDir)

    await waitForEvent(collector, matching: { $0 == "branchChange" })
    // branchChange と同 handleEvents バッチで remotes digest 判定も済む。後続バッチで remote を
    // 動かす操作は無いので、settle 後に remoteRefsChange 不在を確定できる。
    await sleepThreaded(.milliseconds(200))
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
    #expect(events.contains("gitStatusChange"))
    #expect(!events.contains("remoteRefsChange"))
  }

  @Test("root の既存 branch 切替 (.git/HEAD 変化) は head digest 経由で worktreeChange を撃つが branchChange は撃たない")
  func headSwitchFiresWorktreeNotBranch() async throws {
    // branch label (WtCard) は worktree list (`git worktree list --porcelain`) 由来で、その更新経路は
    // worktreeChange であり branchChange ではない。この分離が回帰すると root の branch 切替で branch
    // label が stale になる (commitFiresBranchNotRemoteByDigest と対の回帰ガード)。
    // 機構: root の `git switch existing-branch` は HEAD の symbolic-ref 先だけを動かす (refs/heads は
    // 不変)。classify は head 候補を立て、dispatch の digest gating が `RefDigest.head` の変化を検知して
    // worktreeChange を発火する。heads/remotes は不変なので branchChange/remoteRefsChange は出ない。
    // files backend では `.git/HEAD` が、reftable backend では共有 `reftable/*` が head 候補を立てる
    // 同一経路。本テストは files backend で踏むため CI の git バージョンに依存しない。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)
    let seed = tmpDir.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "seed"], cwd: tmpDir)
    // 切替先の既存 branch を用意する (作成のみ。HEAD は元のまま動かさない)。
    try await runGitCmd(["branch", "other"], cwd: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    // 既存 branch への切替: refs/heads は動かず `.git/HEAD` の symbolic ref 先だけが変わる。
    try await runGitCmd(["switch", "other"], cwd: tmpDir)

    await waitForEvent(collector, matching: { $0 == "worktreeChange" })
    // worktreeChange の settle 窓で branchChange 不在を確定する。
    await sleepThreaded(.milliseconds(200))
    let events = collector.snapshot()
    #expect(events.contains("worktreeChange"))
    #expect(!events.contains("branchChange"))
  }

  @Test("reftable backend: root の既存 branch 切替は head digest 経由で worktreeChange を撃ち branchChange は digest で抑止される")
  func reftableHeadSwitchFiresWorktreeNotBranch() async throws {
    // files backend 版 (headSwitchFiresWorktreeNotBranch) と同じ分離契約を実 reftable repo で
    // end-to-end に固定する。reftable は `.git/HEAD` がスタブで動かず branch 切替が共有
    // `.git/reftable/` 書き換えに funnel されるため、その FSEvent が branch + head 候補として
    // 分類される。digest gating が heads 不変を見て branchChange を抑止し、head 変化で worktreeChange
    // を発火する、という files では踏めない「branch 候補の digest 抑止 + head 発火」の同時経路を踏む。
    // git 2.51+ でのみ実行 (未対応 git は init が失敗するので skip)。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    do {
      try await runGitCmd(["init", "-q", "--ref-format=reftable", "-b", "main"], cwd: tmpDir)
    } catch {
      // reftable 未対応 git (< 2.51)。silent skip を避けるため stderr に残して return。
      FileHandle.standardError.write(
        Data(
          "[FSWatchRegistryTests] skip reftableHeadSwitchFiresWorktreeNotBranch: reftable unsupported (\(error))\n"
            .utf8))
      return
    }
    let seed = tmpDir.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: tmpDir)
    try await runGitCmd(["commit", "-m", "seed"], cwd: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )
    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    // digest baseline を確立する。branch 作成 (heads 変化) で branchChange 候補を 1 度踏ませ、その
    // handleEvents で refDigest が読まれ commonGitDir 単位に保存される。これをやらないと次の switch が
    // 「初回 digest (prev == nil)」になり、branchChange も head も初回無条件発火して branchChange の
    // 抑止 (本テストの主眼) を検証できない。`other` は seed と同一 commit を指すので switch で heads 不変。
    try await runGitCmd(["branch", "other"], cwd: tmpDir)
    await waitForEvent(collector, matching: { $0 == "branchChange" })
    await sleepThreaded(.milliseconds(200))
    collector.clear()

    // 既存 branch への切替: heads/remotes 不変・HEAD の symbolic-ref 先のみ変化。
    try await runGitCmd(["switch", "other"], cwd: tmpDir)

    await waitForEvent(collector, matching: { $0 == "worktreeChange" })
    await sleepThreaded(.milliseconds(200))
    let events = collector.snapshot()
    #expect(events.contains("worktreeChange"))
    #expect(!events.contains("branchChange"))
  }

  @Test("`git pack-refs --all` で packed-refs が更新されると branchChange + gitStatusChange + remoteRefsChange が dispatch される")
  func dispatchesOnPackRefs() async throws {
    // pack 後はファイル名から local / remote のどちらが pack されたか判別不能なため、
    // 3 つの subscriber すべてに通知する設計。pack 自体はテスト時に 0 loose ref でも実行可能。
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    try await runGitCmd(["pack-refs", "--all"], cwd: tmpDir)

    await waitForEvent(collector, matching: { $0 == "branchChange" })
    await waitForEvent(collector, matching: { $0 == "gitStatusChange" })
    await waitForEvent(collector, matching: { $0 == "remoteRefsChange" })
    let events = collector.snapshot()
    #expect(events.contains("branchChange"))
    #expect(events.contains("gitStatusChange"))
    #expect(events.contains("remoteRefsChange"))
  }

  @Test("main repo + worktree clone を並列 watch 中、`.git/worktrees/<name>/` 単独削除で worktreeChange が fire し branchChange は伴走しない")
  func dispatchesWorktreeChangeFromMainOnWorktreeDirRemoval() async throws {
    // primary 選出が「lex 最小」だと wt watcher (gozd 配置の `.local/...`) が main
    // (`ghq/...` 相当) より lex 小で primary を奪う。worktree clone の wt watcher は
    // classify で `applyCommonRule=false` のため `worktrees/<name>/` 削除を
    // `hasWorktreeChange` に分類できず、main 側が立てるが non-primary で suppress
    // されて誰も発火しない死角があった。primary を main worktree に固定した修正の
    // regression guard。
    //
    // bug を実際に踏ませるには wt path が main path より lex 小である必要がある。
    // makeTempDir() の prefix は `gozd-fswatchregistry-` (lex 上 `g...` で始まる) のため、
    // wt root は `a-wt-<uuid>` という prefix で main と同じ親 dir 直下に置き、必ず
    // `a-...` < `gozd-...` (lex) を成立させる。これで「wt が lex 小なのに primary は main」
    // という新規則の本質が test で固定される。
    let mainRepo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: mainRepo) }
    try await initGitRepo(at: mainRepo)

    let seed = mainRepo.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: mainRepo)
    try await runGitCmd(["commit", "-m", "seed"], cwd: mainRepo)

    let worktreeRoot = mainRepo.deletingLastPathComponent()
      .appendingPathComponent("a-wt-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: worktreeRoot) }
    try await runGitCmd(
      ["worktree", "add", "-b", "feature", worktreeRoot.path], cwd: mainRepo)
    let worktreeRootResolved = URL(fileURLWithPath: worktreeRoot.path).resolvingSymlinksInPath()
    let mainRepoResolved = URL(fileURLWithPath: mainRepo.path).resolvingSymlinksInPath()
    // assertion 前提条件: wt path が main path より lex 小であること。
    // 旧 lex-min ルールでこの test が pass しないこと（= bug 再現）の根拠になる。
    #expect(worktreeRootResolved.path < mainRepoResolved.path)

    let worktreeChangeCount = EventCounter()
    let branchChangeCount = EventCounter()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, _ in },
      onBranchChange: { _ in branchChangeCount.increment() },
      onRemoteRefsChange: { _ in },
      onWorktreeChange: { _ in worktreeChangeCount.increment() }
    )

    // main + wt の両方を watch。primary は main worktree に固定されることを期待する。
    try await registry.watch(dir: mainRepo.path)
    try await registry.watch(dir: worktreeRootResolved.path)
    await sleepThreaded(.milliseconds(300))

    // ブランチには触らず `.git/worktrees/<name>/` だけを単独削除して
    // `worktreeChange` 単独経路を踏ませる（`bdc` 経由の `branchChange` 伴走 fetch で
    // 隠蔽されていた死角の再現条件）。
    let perWtGitDir = mainRepo.appendingPathComponent(".git/worktrees")
      .appendingPathComponent(worktreeRoot.lastPathComponent)
    try FileManager.default.removeItem(at: perWtGitDir)

    await waitForCount(worktreeChangeCount, atLeast: 1)
    #expect(worktreeChangeCount.value >= 1)
    // branchChange は伴走しない (本シナリオは worktreeChange 単独経路) こと。
    // 仮に伴走したら、本 test は「branchChange の伴走 fetch で隠蔽されていた死角」を
    // 再現できておらず、worktreeChange 単独経路の regression を捕まえられない。
    #expect(branchChangeCount.value == 0)
  }

  @Test("main repo + worktree clone を並列 watch 中、`pack-refs` で remoteRefsChange が primary 経由で dispatch される")
  func dispatchesRemoteRefsChangeFromPrimaryOnPackedRefs() async throws {
    // `remoteRefsChange` は新規 push event。`branchChange` / `worktreeChange` と同じ
    // primary watcher dispatch コードを共有するが、watcher の handler 接続漏れや
    // dispatch 分岐ミスを classify ユニットテストでは検知できないため、2 watcher 並列で
    // 「primary が確立した状態で dispatch される」invariant をここで守る。
    // `packed-refs` を選んだ理由は、テスト時に `git pack-refs --all` で確定的に再現
    // できるため (`refs/remotes/*` 単独だと remote 設定 + fetch のセットアップが必要)。
    let mainRepo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: mainRepo) }
    try await initGitRepo(at: mainRepo)

    let seed = mainRepo.appendingPathComponent("seed.txt")
    try "seed".write(to: seed, atomically: true, encoding: .utf8)
    try await runGitCmd(["add", "seed.txt"], cwd: mainRepo)
    try await runGitCmd(["commit", "-m", "seed"], cwd: mainRepo)

    let worktreeRoot = mainRepo.deletingLastPathComponent()
      .appendingPathComponent("wt-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: worktreeRoot) }
    try await runGitCmd(
      ["worktree", "add", "-b", "feature", worktreeRoot.path], cwd: mainRepo)

    let remoteRefsChangeCount = EventCounter()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, _ in },
      onBranchChange: { _ in },
      onRemoteRefsChange: { _ in remoteRefsChangeCount.increment() },
      onWorktreeChange: { _ in }
    )

    try await registry.watch(dir: mainRepo.path)
    try await registry.watch(dir: worktreeRoot.path)
    await sleepThreaded(.milliseconds(300))

    try await runGitCmd(["pack-refs", "--all"], cwd: mainRepo)

    await waitForCount(remoteRefsChangeCount, atLeast: 1)
    #expect(remoteRefsChangeCount.value >= 1)
  }

  @Test("同一 dir を再 watch すると entry を保持して refCount を増やす（冪等 + 参照カウント契約）")
  func watchSharesExistingEntryWithRefCount() async throws {
    // dialog + preview / 複数 leaf 等が同じ session log dir を並行 watch する経路の
    // 根本契約: 2 回目の watch は entry を再構築せず refCount を 1 増やすだけ。
    // 1 回目の unwatch では entry が生存し event 受信が継続、2 回目の unwatch で実 unwatch。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    try await initGitRepo(at: tmpDir)

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))
    collector.clear()

    // 1 回目の unwatch: refCount は 2 → 1。entry はまだ生存しているはず。
    await registry.unwatch(dir: tmpDir.path)
    #expect(await registry.isWatching(dir: tmpDir.path) == true)

    // event 受信が継続することを確認 (entry が生存していれば branch ref 変更が dispatch される)。
    let branchFileLive = tmpDir.appendingPathComponent(".git/refs/heads/feature-shared")
    try "0123456789abcdef0123456789abcdef01234567\n"
      .write(to: branchFileLive, atomically: true, encoding: .utf8)
    await waitForEvent(collector, matching: { $0 == "branchChange" })
    #expect(collector.snapshot().contains("branchChange"))
    collector.clear()

    // 2 回目の unwatch: refCount は 1 → 0。entry が解放され、以降 event は届かない。
    await registry.unwatch(dir: tmpDir.path)
    #expect(await registry.isWatching(dir: tmpDir.path) == false)

    let branchFileDead = tmpDir.appendingPathComponent(".git/refs/heads/feature-after-unwatch")
    try "fedcba9876543210fedcba9876543210fedcba98\n"
      .write(to: branchFileDead, atomically: true, encoding: .utf8)
    await sleepThreaded(.milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }

  @Test("多重 watch 中の unwatchAll は refCount を bypass して全 entry を強制解放する")
  func unwatchAllBypassesRefCount() async throws {
    // refCount semantics 導入後の app teardown 経路を守る regression test。
    // 2 回 watch で refCount = 2 の状態でも unwatchAll は 1 回で entry を破棄する。
    let tmpDir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in collector.append("fsChange") },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    let count = await registry.unwatchAll()
    #expect(count == 1)
    #expect(await registry.isWatching(dir: tmpDir.path) == false)
    collector.clear()

    // 強制解放後に file 作成しても dispatch されない。
    let file = tmpDir.appendingPathComponent("after-unwatch-all.txt")
    try "x".write(to: file, atomically: true, encoding: .utf8)
    await sleepThreaded(.milliseconds(500))
    #expect(collector.snapshot().isEmpty)
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: dirA.path)
    try await registry.watch(dir: dirB.path)
    await sleepThreaded(.milliseconds(300))

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

    await sleepThreaded(.milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }

  @Test("entries 空での unwatchAll は 0 件返して no-op")
  func unwatchAllWithNoEntriesReturnsZero() async throws {
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, _ in },
      onBranchChange: { _ in },
      onRemoteRefsChange: { _ in },
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
      onBranchChange: { _ in collector.append("branchChange") },
      onRemoteRefsChange: { _ in collector.append("remoteRefsChange") },
      onWorktreeChange: { _ in collector.append("worktreeChange") }
    )

    try await registry.watch(dir: tmpDir.path)
    await sleepThreaded(.milliseconds(300))

    // unwatch を actor 上で処理させた後に collector を clear する。
    // unwatch 前に clear すると、watch 開始直後の latent event が clear と unwatch の
    // 間に配送される余地が残るため、テストの主旨（「unwatch 以降の変更で dispatch が
    // 走らない」）から外れた失敗が起きうる。
    await registry.unwatch(dir: tmpDir.path)
    collector.clear()

    let file = tmpDir.appendingPathComponent("after-unwatch.txt")
    try "x".write(to: file, atomically: true, encoding: .utf8)

    await sleepThreaded(.milliseconds(500))
    #expect(collector.snapshot().isEmpty)
  }

  @Test("await 後の request 世代 re-check が、後続リクエストに抜かれた古い in-flight status の push を弾く")
  func staleInFlightStatusDroppedByRequestGeneration() async throws {
    // 本 PR (issue #809) の正しさの要である「gitStatusFull の await 後 request 世代 re-check」を
    // 決定的に踏む。実 git では status の完了タイミングを制御できないため、status fetcher を注入し
    // 完了を gate する。SIGTERM 到達前に正常完了した古い in-flight (cancel では止まらない) が
    // 新しい結果を上書きしないことを固定する。fetcher を注入する以上、debounce 窓は短く (20ms) して
    // event ごとに別 fetch を踏ませる (production の 150ms 畳み込みとは別の検証軸)。
    let repo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: repo) }
    try await initGitRepo(at: repo)

    // call#0 = statusA (in-flight に保持して後で stale 化)、call#1 = statusB (最新として push)。
    // statuses のキーで A/B を識別する。
    let statusA = GitOps.StatusFull(
      statuses: ["a.txt": "??"], renameOldPaths: [:], head: "", branchHead: "main",
      hasUpstream: false, ahead: 0, behind: 0, latestMtime: 0)
    let statusB = GitOps.StatusFull(
      statuses: ["b.txt": "??"], renameOldPaths: [:], head: "", branchHead: "main",
      hasUpstream: false, ahead: 0, behind: 0, latestMtime: 0)
    let fetcher = GatedStatusFetcher(statuses: [statusA, statusB])

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, status in
        collector.append("status:\(status.statuses.keys.sorted().joined(separator: ","))")
      },
      onBranchChange: { _ in },
      onRemoteRefsChange: { _ in },
      onWorktreeChange: { _ in },
      statusDebounce: .milliseconds(20),
      statusFetcher: { _ in await fetcher.fetch() }
    )

    try await registry.watch(dir: repo.path)
    await sleepThreaded(.milliseconds(300))

    // 1 回目の working-tree 変更 → debounce 後 fetcher#0 が呼ばれ statusA を抱えてブロック (in-flight)。
    // fetcher.callsMade は NSLock 同期読みなので waitUntil の同期 predicate で踏める (FSEvents
    // propagation 待ち — WaitUntil.swift の用途規律「OS event 到達待ち」に該当)。
    try "a".write(to: repo.appendingPathComponent("a.txt"), atomically: false, encoding: .utf8)
    await waitUntil(
      timeout: .seconds(2), description: "fetcher call #0 in-flight",
      lastObserved: { "calls=\(fetcher.callsMade)" }
    ) { fetcher.callsMade >= 1 }

    // 2 回目の working-tree 変更 → request 世代が進む。fetcher#1 (statusB) は先に release しておき、
    // 最新リクエストとして push される。
    fetcher.release(call: 1)
    try "b".write(to: repo.appendingPathComponent("b.txt"), atomically: false, encoding: .utf8)
    await waitForEvent(collector, matching: { $0 == "status:b.txt" })

    // in-flight だった fetcher#0 を今 release する。古い request 世代 (call#0) なので await 後の
    // re-check で弾かれ、statusA は push されない。settle 窓で不在を確定する。
    fetcher.release(call: 0)
    await sleepThreaded(.milliseconds(300))

    let events = collector.snapshot()
    #expect(events.contains("status:b.txt"))
    #expect(!events.contains("status:a.txt"))
  }

  @Test("await 後の watch 世代 re-check が、unwatch を跨いだ古い in-flight status の push を弾く")
  func staleInFlightStatusDroppedByWatchGenerationOnUnwatch() async throws {
    // request 世代版と対の regression guard。in-flight の gitStatusFull の await 中に unwatch される
    // ケースで、entry 消滅 (watch 世代の無効化) を await 後の isActive re-check が捕まえ、stale な
    // status を push しないことを固定する。
    let repo = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: repo) }
    try await initGitRepo(at: repo)

    let statusA = GitOps.StatusFull(
      statuses: ["a.txt": "??"], renameOldPaths: [:], head: "", branchHead: "main",
      hasUpstream: false, ahead: 0, behind: 0, latestMtime: 0)
    let fetcher = GatedStatusFetcher(statuses: [statusA])

    let collector = EventNameCollector()
    let registry = FSWatchRegistry(
      onFsChange: { _, _ in },
      onGitStatusChange: { _, _ in collector.append("gitStatusChange") },
      onBranchChange: { _ in },
      onRemoteRefsChange: { _ in },
      onWorktreeChange: { _ in },
      statusDebounce: .milliseconds(20),
      statusFetcher: { _ in await fetcher.fetch() }
    )

    try await registry.watch(dir: repo.path)
    await sleepThreaded(.milliseconds(300))

    // working-tree 変更 → debounce 後 fetcher#0 が statusA を抱えてブロック (in-flight)。
    try "a".write(to: repo.appendingPathComponent("a.txt"), atomically: false, encoding: .utf8)
    await waitUntil(
      timeout: .seconds(2), description: "fetcher call #0 in-flight",
      lastObserved: { "calls=\(fetcher.callsMade)" }
    ) { fetcher.callsMade >= 1 }

    // in-flight のまま unwatch。entry が消え watch 世代が無効化される。
    await registry.unwatch(dir: repo.path)

    // in-flight だった fetcher#0 を release。unwatch 済みなので await 後の isActive(watch 世代)
    // re-check で弾かれ、statusA は push されない。
    fetcher.release(call: 0)
    await sleepThreaded(.milliseconds(300))

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

  @Test("worktree 配置: secondary 自身の per-worktree HEAD は gitStatusChange のみ（worktreeChange は root watcher が担う）")
  func worktreePerWorktreeHead() {
    // perWtSameAsCommon == false の secondary watcher。自身の HEAD 変化で worktreeChange を
    // 立てると root watcher (common 規則 `worktrees/...`) と二重発火するため立てない。
    // root の HEAD 変化 (perWtSameAsCommon == true) のみ worktreeChange を立てる契約の対称側。
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

  @Test("worktree 配置: common git dir 配下の refs/remotes/origin/main は gitStatusChange + remoteRefsChange")
  func worktreeCommonRemoteRef() {
    // git push / fetch 成功でローカルの remote-tracking ref が書き換わる。
    // - `gitStatusChange`: per-worktree の ahead/behind 更新
    // - `remoteRefsChange`: repo スコープの ref トポロジ変化 (current 以外の branch が動いた場合の git-graph 再 load)
    // worktree 一覧構造は変わらないため branchChange は発火させない。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "refs", "remotes", "origin", "main"))])
    #expect(result.hasGitStatusChange)
    #expect(result.hasRemoteRefsChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasFsChange)
    #expect(!result.hasWorktreeChange)
  }

  @Test("worktree 配置: refs/remotes/origin/HEAD（symbolic ref）も gitStatusChange + remoteRefsChange")
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
    #expect(result.hasRemoteRefsChange)
    #expect(!result.hasBranchChange)
  }

  @Test("worktree 配置: branch 名にスラッシュを含む refs/remotes/origin/feature/sub も gitStatusChange + remoteRefsChange")
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
    #expect(result.hasRemoteRefsChange)
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
    // HEAD は perWtSameAsCommon (= root / main worktree) なので headChange 候補も立つ。
    #expect(result.hasHeadChange)
    #expect(!result.hasWorktreeChange)
    // 通常 clone でも .git 配下は作業ツリー判定に乗せない
    #expect(!result.hasFsChange)
  }

  @Test("root 切替の主因: 通常 clone の .git/HEAD 単独変化は gitStatusChange + headChange（branchChange / worktreeChange は伴わない）")
  func normalCloneHeadOnlyFiresHeadChange() {
    // `git switch existing-branch` を root (main worktree) で実行した状況。`.git/HEAD` の
    // symbolic ref 先だけが変わり refs/heads は動かない。HEAD で headChange 候補を立てないと
    // dispatch の digest gating が worktreeChange を発火できず、worktree list が refetch されず
    // サイドバーの branch label が古いまま残る。worktreeChange を path で直接立てず head 候補に
    // するのは、dispatch 側が `RefDigest.head` の内容比較で「symbolic-ref 先が実際に変わったか」を
    // 判定し commit (HEAD touch でも symbolic-ref 先は不変) で誤発火しないため。secondary worktree
    // (`.git/worktrees/<name>/HEAD`) は root watcher が common `worktrees/` 規則で worktreeChange を
    // 出すため即反映され、root だけ取りこぼす非対称を塞ぐ regression guard。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "HEAD"))])
    #expect(result.hasGitStatusChange)
    #expect(result.hasHeadChange)
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasFsChange)
  }

  @Test("通常 clone: .git/index 単独変化は gitStatusChange のみ（worktreeChange は立たない）")
  func normalCloneIndexOnly() {
    // index は staging の変化であって branch 切替ではないため worktree list refetch は不要。
    // HEAD と index の分岐を取り違えない契約を固定する。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "index"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasBranchChange)
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

  @Test("git dir nil（非 repo）: 作業ツリー配下のファイルは fsChange のみ（gitStatusChange は立てない）")
  func nonRepoFallsToWorkTreeBranch() {
    // commonGitDir == nil は非 git dir の watch (session log dialog が監視する
    // ~/.claude/projects/<encoded>/ 等)。git status の概念が無いため gitStatusChange を
    // 立てない。立てると handleEvents が `git status` を exit 128 で throw させ、ファイル
    // 変更のたびに stderr へ `gitStatusFull failed` を吐いて観察ログを汚す。
    let dir = pathOf("somewhere")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: nil, commonGitDir: nil,
      events: [ev(pathOf("somewhere", "note.txt"))])
    #expect(result.hasFsChange)
    #expect(!result.hasGitStatusChange)
    #expect(result.fsRelDirs == [""])
  }

  @Test("packed-refs 変更で branchChange + gitStatusChange + remoteRefsChange が立つ")
  func packedRefsFiresBoth() {
    // packed-refs は local / remote の判別ができないため、全 subscriber に通知する。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "packed-refs"))])
    #expect(result.hasBranchChange)
    #expect(result.hasGitStatusChange)
    #expect(result.hasRemoteRefsChange)
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

  // MARK: - reftable backend (Git 2.51+、3.0 で default 化)

  @Test("reftable backend root: .git/reftable/tables.list 変化は branch + remote + status + head 候補（packed-refs + HEAD と等価）")
  func reftableRootSharedStore() {
    // reftable では HEAD スタブが `ref: refs/heads/.invalid` 固定で動かず、branch 切替・作成・
    // 削除・rename・fetch がすべて共有テーブル `.git/reftable/` の書き換えに funnel される。
    // local / remote / HEAD を種別判別できないため packed-refs と同じく branch / remote / status の
    // 候補を全発火させる。これが無いと無分類で silent drop され、reftable repo で branch 表示が永久に
    // 更新されない。
    // 加えて root では head 候補も立てる: files backend では root の `git switch` が `.git/HEAD` を
    // 動かして HEAD 規則が head 候補を立てるが、reftable では HEAD が動かずこの共有テーブルが唯一の
    // signal。実際にどのカテゴリ (heads / remotes / head) が動いたかは dispatch の `RefDigest` 内容
    // 比較が確定する。既存 branch 切替では heads/remotes 不変・head のみ変化 → worktreeChange のみ
    // 発火し branchChange/remoteRefsChange は抑止される (これが reftable root 切替で branch label を
    // 更新する正規経路)。worktreeChange は path で直接立てない (commit でも共有テーブルは動くため、
    // 内容比較で head 不変を確認して誤発火を防ぐ)。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "reftable", "tables.list"))])
    #expect(result.hasBranchChange)
    #expect(result.hasRemoteRefsChange)
    #expect(result.hasGitStatusChange)
    #expect(result.hasHeadChange)
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasFsChange)
  }

  @Test("reftable backend secondary 自身: per-wt reftable 変化は gitStatusChange のみ（worktreeChange は root watcher が担う）")
  func reftableSecondaryOwnStore() {
    // secondary の per-worktree refs は `.git/worktrees/<name>/reftable/` に置かれる。自身の
    // watcher (perWtSameAsCommon == false) では、そのチェックアウト先変化を status 再取得に
    // 倒す。branch label の list 再取得は root watcher が下の common `worktrees/` 規則で拾う。
    let dir = pathOf("wt", "foo")
    let perWt = pathOf("parent", ".git", "worktrees", "foo")
    let common = pathOf("parent", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: perWt, commonGitDir: common,
      events: [ev(pathOf("parent", ".git", "worktrees", "foo", "reftable", "tables.list"))])
    #expect(result.hasGitStatusChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasRemoteRefsChange)
    #expect(!result.hasWorktreeChange)
    #expect(!result.hasFsChange)
  }

  @Test("reftable backend: root watcher から見た secondary の per-wt reftable 変化は worktreeChange")
  func reftableSecondarySeenByRoot() {
    // root watcher (perWtSameAsCommon == true) は common 規則で `.git/worktrees/<name>/...` を
    // 拾う。reftable / HEAD どちらの per-wt ref store 変化でも `worktrees/` prefix で
    // worktreeChange を立て、worktree list を refetch して secondary の branch label を更新する。
    let dir = pathOf("repo")
    let gitDir = pathOf("repo", ".git")
    let result = FSWatchRegistry.classify(
      dir: dir, perWorktreeGitDir: gitDir, commonGitDir: gitDir,
      events: [ev(pathOf("repo", ".git", "worktrees", "foo", "reftable", "tables.list"))])
    #expect(result.hasWorktreeChange)
    #expect(!result.hasBranchChange)
    #expect(!result.hasRemoteRefsChange)
    #expect(!result.hasGitStatusChange)
    #expect(!result.hasHeadChange)
    #expect(!result.hasFsChange)
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

// `waitUntil` ( dedicated NSThread polling ) の wrapper。timeout 時には `lastObserved`
// 経路で collector snapshot / counter 値を inline 出力し、tick 履歴 ( true/false 列 ) では
// 表せない「何が来たか / 実値が幾つか」を Issue.record の message に残す。
private func waitForEvent(
  _ collector: EventNameCollector,
  timeout: Duration = .seconds(2),
  matching predicate: @escaping @Sendable (String) -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  await waitUntil(
    timeout: timeout,
    description: "event matching predicate",
    lastObserved: { collector.snapshot().description },
    {
      collector.snapshot().contains(where: predicate)
    },
    sourceLocation: sourceLocation)
}

private func waitForCount(
  _ counter: EventCounter,
  atLeast target: Int,
  timeout: Duration = .seconds(2),
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  await waitUntil(
    timeout: timeout,
    description: "count >= \(target)",
    lastObserved: { "count=\(counter.value)" },
    {
      counter.value >= target
    },
    sourceLocation: sourceLocation)
}

private final class EventCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count: Int = 0

  func increment() {
    lock.lock()
    defer { lock.unlock() }
    count += 1
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}

/// FSWatchRegistry に注入する status fetcher の test double。呼ばれた順に index を振り、
/// `release(call:)` されるまでブロックして `statuses[index]` を返す。`gitStatusFull` の完了
/// タイミングを test 側で制御し、await 後の世代 re-check (古い in-flight が新しい結果を上書き
/// しないこと) を決定的に踏むための seam。cancel には応答しない (SIGTERM 到達前に正常完了する
/// in-flight を模す)。`callsMade` は NSLock 同期読みで `waitUntil` の同期 predicate から踏める。
private final class GatedStatusFetcher: @unchecked Sendable {
  private let lock = NSLock()
  private let statuses: [GitOps.StatusFull]
  private var callCount = 0
  private var gates: [Int: CheckedContinuation<Void, Never>] = [:]
  private var released: Set<Int> = []

  init(statuses: [GitOps.StatusFull]) {
    self.statuses = statuses
  }

  func fetch() async -> GitOps.StatusFull {
    let index: Int = {
      lock.lock()
      defer { lock.unlock() }
      let i = callCount
      callCount += 1
      return i
    }()
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      lock.lock()
      // continuation 登録前に release が来ていれば即 resume (lock 区間での race を閉じる)。
      if released.contains(index) {
        lock.unlock()
        cont.resume()
      } else {
        gates[index] = cont
        lock.unlock()
      }
    }
    return statusAt(index)
  }

  func release(call index: Int) {
    lock.lock()
    released.insert(index)
    let cont = gates.removeValue(forKey: index)
    lock.unlock()
    cont?.resume()
  }

  var callsMade: Int {
    lock.lock()
    defer { lock.unlock() }
    return callCount
  }

  private func statusAt(_ index: Int) -> GitOps.StatusFull {
    if index < statuses.count { return statuses[index] }
    return statuses.last ?? GatedStatusFetcher.emptyStatus
  }

  static let emptyStatus = GitOps.StatusFull(
    statuses: [:], renameOldPaths: [:], head: "", branchHead: "",
    hasUpstream: false, ahead: 0, behind: 0, latestMtime: 0)
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
