import Foundation

// dir 単位で FSWatcher を保持し、再帰的なファイル変更を 4 種類の push event に
// 振り分ける actor。
//
// 設計判断:
//
// 1. **dir をキーにした 1 watcher 1 dir**。worktree ごとに renderer から
//    `/fs/watch` で登録され、worktree を閉じる時に `/fs/unwatch` で解除する。
//
// 2. **イベント分類**（ref backend 非依存）:
//    分類は files backend (loose `refs/` + `packed-refs`) と reftable backend
//    (Git 2.51+、3.0 で default 化。ref をバイナリテーブル `reftable/` に格納) の両方を
//    トリガーとして扱う。どちらの backend でも真値は porcelain (`git worktree list
//    --porcelain` / `git status --porcelain=v2 --branch`) で読み直すため、ここでの分類は
//    「どの porcelain を再取得すべきか」を決める signal でしかない。backend の物理 layout に
//    白名簿を焼き込むと、reftable のように layout が変わった瞬間に無分類 silent drop で
//    表示が永久に更新されなくなる（過去 root の `git switch` 反映バグの真因）ため、両 layout を
//    明示的にトリガーに含める。
//    - per-worktree git dir 配下の `index` → `gitStatusChange`
//    - per-worktree git dir 配下の `HEAD` → `gitStatusChange`
//      （files backend のみ。+ main worktree / 通常 clone では `worktreeChange` も。HEAD の
//      参照先 branch が変わると worktree list の per-wt branch 出力が変わるため list を refetch
//      させる。reftable では HEAD はスタブ固定で動かず、下の `reftable/` 規則が担う）
//    - per-worktree git dir 配下の `reftable/...` → `gitStatusChange`
//      （reftable backend。その worktree のチェックアウト先 ref が変わった signal）
//    - common git dir 配下の `refs/heads/...` → `branchChange`（files backend）
//    - common git dir 配下の `refs/remotes/...` → `gitStatusChange` + `remoteRefsChange`
//      （files backend。`git push` / `git fetch` 成功時にローカルの remote-tracking ref が
//      書き換わる。`gitStatusChange` で per-worktree の ahead/behind を更新しつつ、
//      `remoteRefsChange` で repo スコープの ref トポロジ変化を git-graph に通知する。current
//      branch 以外の remote ref が動いたとき、`gitStatusChange` の `# branch.ab` だけでは
//      検知できないため、git log を再取得する別経路を分けて持つ）
//    - common git dir 配下の `packed-refs` → `branchChange` + `gitStatusChange` + `remoteRefsChange`
//      （files backend。pack 後はローカル ref と remote-tracking ref のどちらが書き換わったか
//      ファイル名だけでは判別できないため、両方を発火させる）
//    - common git dir 配下の `reftable/...` → `branchChange` + `gitStatusChange` + `remoteRefsChange`
//      （reftable backend。local / remote / HEAD がバイナリテーブルに同居し種別判別不能なため
//      packed-refs と同じく全発火。files backend の refs/heads・refs/remotes・packed-refs・HEAD
//      規則と機能的に等価な reftable 経路）
//    - common git dir 配下の `worktrees/...` → `worktreeChange`
//      （secondary worktree の per-wt git dir 配下の変化 — `HEAD` / `reftable/` 含む — を
//      root watcher がここで拾い、worktree list を refetch して secondary の branch label を更新する）
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
// 5. **watch 起動往復中の取りこぼし救済**。`rpcFsWatch` 応答直後の `fsWatchReady` push を
//    renderer 内部で 1 度だけ発射し、購読側に該当 worktree の state を再 fetch させる。
//    `callJavaScript` の失敗による永続ズレは pushToRenderer のログで観測可能。低頻度 pull
//    による整合性チェッカは廃止: 全 worktree watch + per-dir push filter で
//    SSOT 経路の到達率は実用的に十分で、ポーリングは GitHub rate limit / `gh` 経路と組み
//    合わさると累積発火の温床になる。
public actor FSWatchRegistry {
  public typealias FsChangeHandler = @Sendable (_ dir: String, _ relDir: String) -> Void
  public typealias GitStatusChangeHandler = @Sendable (_ dir: String, _ status: GitOps.StatusFull)
    -> Void
  /// branchChange ハンドラ。同 repo を共有する worktree 群の中から primary 1 つだけが
  /// 発火するため、push は repo につき 1 回 / バッチ。
  public typealias BranchChangeHandler = @Sendable (_ dir: String) -> Void
  /// remoteRefsChange ハンドラ。`refs/remotes/...` / `packed-refs` 由来。
  /// `branchChange` と同じく commonGitDir 単位の primary watcher 1 つに collapse される。
  public typealias RemoteRefsChangeHandler = @Sendable (_ dir: String) -> Void
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
    /// 同一 resolved dir に対する `watch` 呼び出し回数。`unwatch` で 0 になった時点で
    /// 実 FSWatcher を停止する。dialog + preview / 複数 leaf 等、同じ session log dir を
    /// 異なる購読者が並行 watch するケースで「片方の unwatch がもう片方の watch も解放する」
    /// 破れを構造的に防ぐ。renderer 側は 1 購読 = 1 watch / 1 unwatch のペアを守る前提。
    var refCount: Int
  }

  // 分岐網羅テスト容易性のため internal で公開する。dispatch は actor 内で完結するため
  // この struct を外部から直接組み立てる用途は無い。
  struct Classification: Equatable {
    let fsRelDirs: Set<String>
    let hasFsChange: Bool
    let hasGitStatusChange: Bool
    let hasBranchChange: Bool
    let hasRemoteRefsChange: Bool
    let hasWorktreeChange: Bool
    /// HEAD (current branch) が動いた可能性のある候補。`.git/HEAD` (files の main worktree) /
    /// 共有 `reftable/*` (reftable) など、checkout 先が変わりうる ref store event で立つ。
    /// 実際に動いたかは primary watcher が `RefDigest.head` を内容比較して判定し、変化していれば
    /// worktreeChange を発火する (branch 切替で変化、branch 上の commit では不変)。`worktrees/*`
    /// 構造変化由来の `hasWorktreeChange` (worktree 追加削除 / secondary 切替) とは別経路。
    let hasHeadChange: Bool
  }

  private let onFsChange: FsChangeHandler
  private let onGitStatusChange: GitStatusChangeHandler
  private let onBranchChange: BranchChangeHandler
  private let onRemoteRefsChange: RemoteRefsChangeHandler
  private let onWorktreeChange: WorktreeChangeHandler
  private var entries: [String: Entry] = [:]
  /// watch 時に renderer から渡された原文 dir → realpath 解決後のキー の逆引き。
  /// unwatch 時にディレクトリが既に削除されていると `realpath(3)` が失敗してフォールバックで
  /// 入力 path をそのまま返すため、watch 時のキーと一致せず entries が leak する。
  /// この逆引きを使えば「watch 時に解決した resolved key」で確実に削除できる。
  private var resolvedKeyByOriginalDir: [String: String] = [:]
  /// commonGitDir → primary watcher の resolved dir。`branchChange` / `worktreeChange`
  /// dispatch 時の dedup に使う。primary 判定は main worktree (`perWorktreeGitDir ==
  /// commonGitDir`) を選ぶ。entries の add / remove 時に該当 commonGitDir のグループだけ
  /// 再計算する (handleEvents での O(N) 走査を O(1) lookup に置き換える)。
  /// 選出理由は `recomputePrimary` の docstring を参照。
  private var primaryByCommonGitDir: [String: String] = [:]
  /// commonGitDir → 直近に観測した local/remote ref digest。`branchChange` / `remoteRefsChange`
  /// は path 分類では「ref store が動いた候補」までしか分からない。reftable backend は
  /// local / remote / HEAD を 1 テーブルに同居させ commit でも共有テーブルを書き換えるため、
  /// path だけで remoteRefsChange を立てると commit のたびに renderer の `gh pr list` を撃って
  /// GitHub rate limit を累積発火させる。候補が立った primary watcher で `GitOps.refDigest` を
  /// 読み、前回値と差があるカテゴリ (heads / remotes / head) だけを dispatch するための内容比較
  /// キャッシュ。head は現在 branch (symbolic-ref 先) で、変化したら worktreeChange を発火し
  /// reftable でも branch 切替を backend 非依存に捕捉する。初回 (key 不在) は無条件発火で renderer
  /// と baseline を合わせる。primary が消えた commonGitDir は `recomputePrimary` が key を落とし、
  /// 再 watch 時に baseline を張り直す。
  private var lastRefDigestByCommonGitDir: [String: GitOps.RefDigest] = [:]
  /// resolved dir → 直近に push 済みの `StatusFull`。同一内容の `gitStatusChange` 連射を
  /// 止めるための dedup キャッシュ。
  ///
  /// 作業ツリー側のファイル変更は gitignore 対象（`.tsbuildinfo` / `node_modules` /
  /// `dist` 等のビルド成果物）であっても `classify` で `gitStatusChange` に分類される
  /// （git dir 外の変更は untracked / 差分の可能性があるため一律立てる）。だが
  /// `git status` の出力は ignore ファイルを除外するので `StatusFull` は前回と同一になる。
  /// typecheck / ビルド中はこの「内容不変の push」が連射され、renderer 側 `setWorktreeGitStatuses`
  /// の参照差し替えを通じて changes / filer ビューが再描画され続ける。直近 push 値と一致する
  /// 間は push をスキップしてこれを止める。初期値が無いため最初の status は必ず push される。
  ///
  /// キーは realpath 解決済み dir なので再 watch でキー自体は変わらない。entry の
  /// ライフサイクル状態として扱い、`_unwatch` / `watch` の再構築で破棄する。これにより
  /// torn-down 前の値が次の watch サイクルの最初の push を握り潰すのを防ぐ。再 watch 時は
  /// `fsWatchReady` 経由で renderer が再 fetch して baseline を張り直すため、最初の status を
  /// 無条件 push して native の cache と renderer を再同期させる。
  private var lastPushedStatusByDir: [String: GitOps.StatusFull] = [:]
  /// watch ごとに増える世代番号。unwatch 後に積まれていた stale event の dispatch を
  /// 抑止するため、event 配送前後に entries[dir]?.generation と一致するか check する。
  private var nextGeneration: UInt64 = 0

  public init(
    onFsChange: @escaping FsChangeHandler,
    onGitStatusChange: @escaping GitStatusChangeHandler,
    onBranchChange: @escaping BranchChangeHandler,
    onRemoteRefsChange: @escaping RemoteRefsChangeHandler,
    onWorktreeChange: @escaping WorktreeChangeHandler
  ) {
    self.onFsChange = onFsChange
    self.onGitStatusChange = onGitStatusChange
    self.onBranchChange = onBranchChange
    self.onRemoteRefsChange = onRemoteRefsChange
    self.onWorktreeChange = onWorktreeChange
  }

  /// dir の監視を開始する。同一 resolved dir に対する `watch` 呼び出しは冪等で
  /// refCount を 1 増やすだけ。最初の購読者で実際の FSWatcher を構築する。
  /// 入力 dir は realpath 解決してキーに使う（FSEvents は realpath を返すため、
  /// `/var/...` と `/private/var/...` のような symlink の差を吸収する）。
  ///
  /// **参照カウント**: dialog + preview / 複数 leaf など、同一 session log dir を
  /// 複数の購読者が並行 watch するケースに対応する。renderer 側は 1 購読 = 1 watch /
  /// 1 unwatch のペアを守る前提で、refCount が 0 になった時点でのみ実 unwatch する。
  ///
  /// **再構築の責任分離**: `git worktree repair` 等で git dir 解決値が変わったケースの
  /// 対応は呼び出し側の責務とする (明示的に `unwatch` してから `watch` を呼ぶ)。
  /// この registry は冪等な参照カウントだけを保証し、解決値の再評価は触らない。
  /// 旧設計では `watch` 内で `entries[dir]` を強制再構築していたが、それは
  /// 「同一 dir に複数購読者」前提と両立できないため切り離した。
  ///
  /// **死契約の明示**: 現状の呼び出し側 (`useFsWatchSync` / `useSessionLogLive`) には
  /// `git worktree repair` を検知して unwatch + watch を発射する hook は存在しない。
  /// repair 後は旧 git dir 解決値で `classify` し続け、`classify` の分岐が永続的に
  /// 間違う可能性がある。実用上の頻度が低いため YAGNI と判断し、git dir 解決値の動的
  /// 変化はアプリ再起動でリセットする運用契約とする (検知 hook が必要になった時点で
  /// 呼び出し側に実装する)。
  public func watch(dir userDir: String) async throws {
    let dir = FSWatchRegistry.realpath(userDir)
    if var existing = entries[dir] {
      existing.refCount += 1
      entries[dir] = existing
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
      commonGitDir: commonGitDir,
      refCount: 1)
    resolvedKeyByOriginalDir[userDir] = dir
    if let commonGitDir {
      recomputePrimary(forCommonGitDir: commonGitDir)
    }
  }

  /// dir の監視を停止する。watch されていなければ no-op。
  /// 削除済みパスでは `realpath(3)` がフォールバックで入力 path を返すため、
  /// watch 時に保存した逆引きを優先してキーを引く（leak 防止）。
  ///
  /// **セマンティクス**: refCount を 1 減らし、0 になった時点で実 FSWatcher を停止する。
  /// dialog + preview / 複数 leaf 等が同じ session log dir を並行 watch しているとき、
  /// 1 購読者の unwatch では entry を解放せず、最後の購読者の unwatch でのみ実 unwatch
  /// する。renderer 側は 1 mount = 1 watch / 1 unmount = 1 unwatch のペアを守る前提。
  public func unwatch(dir userDir: String) {
    let resolvedKey = resolvedKeyByOriginalDir[userDir] ?? FSWatchRegistry.realpath(userDir)
    guard var entry = entries[resolvedKey] else {
      resolvedKeyByOriginalDir.removeValue(forKey: userDir)
      return
    }
    entry.refCount -= 1
    if entry.refCount <= 0 {
      _unwatch(realpathDir: resolvedKey)
      return
    }
    entries[resolvedKey] = entry
    // 逆引き (resolvedKeyByOriginalDir) は entry の lifecycle に揃え、最終購読者の
    // unwatch (refCount == 0) で `_unwatch` がまとめて消す。ここで早期削除すると、
    // 次回 unwatch 時に `realpath(userDir)` フォールバックに頼ることになり、dir が
    // 削除済み環境で resolved key が一致せず entry leak の race を開く。
  }

  /// 保持している全 entry の監視を一括停止する。renderer の `onUnmounted` から
  /// 1 度の RPC で呼び出され、FSEventStream slot を残骸として残さないための
  /// 構造的 cleanup 経路。返り値は実際に破棄した entry 数（観察可能性用）。
  ///
  /// **refCount bypass**: 個別 `unwatch` と異なり、refCount に関わらず全 entry を強制
  /// 解放する。app teardown / 全 watch 一括 reset の専用経路として使うこと。dialog +
  /// preview 等が refCount で並行 watch している最中に呼ぶと、他購読者が抱えていた
  /// `currentWatchDir` が stale 化し、次の `unwatch` 呼び出しは entry 不在で no-op になる。
  public func unwatchAll() -> Int {
    let dirs = Array(entries.keys)
    for dir in dirs {
      _unwatch(realpathDir: dir)
    }
    return dirs.count
  }

  /// realpath 解決済みの dir に対して unwatch する内部 helper。`watch` での再構築経路と
  /// public `unwatch` の両方から呼ばれる。reverse lookup の掃除もここで完結させる。
  private func _unwatch(realpathDir dir: String) {
    guard let entry = entries.removeValue(forKey: dir) else { return }
    entry.watcher.stop()
    entry.continuation.finish()
    entry.task.cancel()
    // dedup キャッシュも掃除する。再 watch 後の最初の status を無条件 push させ、
    // dir 削除後の別 repo 再配置などで stale 値が次の push を握り潰すのを防ぐ。
    lastPushedStatusByDir.removeValue(forKey: dir)
    // 同一 resolved dir を指していた他の userDir 逆引きも掃除する。
    // 同一 resolved に複数 userDir（symlink パスと非 symlink パスなど）で watch が
    // 重ねられた状態で、片方しか unwatch されないと逆引きエントリが leak するため。
    resolvedKeyByOriginalDir = resolvedKeyByOriginalDir.filter { $0.value != dir }
    if let commonGitDir = entry.commonGitDir {
      recomputePrimary(forCommonGitDir: commonGitDir)
    }
  }

  /// dispatch 時点で entry がまだ生きており、世代が一致するかを判定する。
  /// FSEvents の遅延配信や gitStatusFull の await 後に entry が消えていれば false。
  private func isActive(dir: String, generation: UInt64) -> Bool {
    entries[dir]?.generation == generation
  }

  /// 同じ commonGitDir を共有する watcher 群の中で、指定 dir が primary かを判定する。
  /// O(1) lookup: primary は `primaryByCommonGitDir` cache から読み、entries 全件走査は
  /// しない (entry 追加 / 削除時にしか更新されないため frequent path で線形走査しない)。
  /// commonGitDir が nil (非 git project) の entry は classify 時に branchChange /
  /// worktreeChange を立てないため、ここに到達する経路自体存在しないが、保守上の保険として
  /// false を返す (primary でない = dispatch を抑止する側に倒す)。
  private func isPrimaryWatcher(forCommonGitDir commonGitDir: String?, dir: String) -> Bool {
    guard let commonGitDir else { return false }
    return primaryByCommonGitDir[commonGitDir] == dir
  }

  /// `primaryByCommonGitDir` を該当 commonGitDir のグループに対して再計算する。
  /// entry の追加 / 削除時に呼ぶ。グループに entry が残っていなければ map から消す。
  /// 選出基準: main worktree (`perWorktreeGitDir == commonGitDir`) を primary にする。
  /// 旧実装の「resolved dir の lex 最小」は、gozd 配置 wt path (`.local/share/...`) が
  /// main repo path (`ghq/...`) より lex 小になるため wt が primary を奪う。worktree clone
  /// の wt watcher は classify で `applyCommonRule` が false となり `hasWorktreeChange` を
  /// 立てない一方、main watcher は `perWtSameAsCommon=true` なので立てる。primary が wt の
  /// 状態で `.git/worktrees/<name>/` 単独削除が起きると、worktreeChange を立てる側 (root)
  /// は primary 抑止で suppress、立てない側 (wt) が primary で何も発火しない経路に陥る。
  /// main worktree は `git worktree remove` で消せない invariant も併せ持つため、発火元と
  /// して常に生存する。
  private func recomputePrimary(forCommonGitDir commonGitDir: String) {
    for (key, entry) in entries where entry.commonGitDir == commonGitDir {
      if entry.perWorktreeGitDir == commonGitDir {
        primaryByCommonGitDir[commonGitDir] = key
        return
      }
    }
    primaryByCommonGitDir.removeValue(forKey: commonGitDir)
    // primary が消えたら ref digest の baseline も破棄する。primary 不在の間は誰も digest を
    // 更新しないので、stale 値が次の primary 確立後の初回判定を誤らせるのを防ぐ (再 watch 時は
    // key 不在 → 無条件発火で baseline を張り直す)。
    lastRefDigestByCommonGitDir.removeValue(forKey: commonGitDir)
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
    // `branchChange` / `remoteRefsChange` / `worktreeChange` は common git dir 配下の
    // event から派生し、repo を共有する全 worktree の watcher が同じ event で同時発火する。
    // ここで commonGitDir 単位の primary watcher 1 つに collapse し、N 個の watcher 由来の
    // N 連射を 1 push にまとめる。primary は main worktree
    // (`perWorktreeGitDir == commonGitDir`) を選ぶ (`recomputePrimary` 参照)。
    let isPrimaryForCommonDir = isPrimaryWatcher(forCommonGitDir: entry.commonGitDir, dir: dir)
    // primary watcher が未確立で repo-scope event を立てた場合は silent drop に
    // 陥る。renderer (useFsWatchSync) は repo を開いた時点で main worktree も登録するため
    // 通常運用では発生しないが、`watch()` の `await GitOps.gitDirs` 中に non-main wt の event
    // が先に届く startup race / bare repo / 単体テストでの部分登録で起こり得る。観察可能化
    // のため stderr にログする。dispatch 自体は contract どおり走らない。
    // entries の dir 一覧と各 entry が main worktree (`perWorktreeGitDir == commonGitDir`)
    // かどうかを併記して、startup race か bare repo か永続未確立かを log から切り分け可能にする。
    if (result.hasBranchChange || result.hasRemoteRefsChange || result.hasWorktreeChange
      || result.hasHeadChange)
      && !isPrimaryForCommonDir,
      let commonGitDir = entry.commonGitDir,
      primaryByCommonGitDir[commonGitDir] == nil
    {
      let siblings = entries
        .filter { _, e in e.commonGitDir == commonGitDir }
        .map { key, e in "\(key)(main=\(e.perWorktreeGitDir == commonGitDir))" }
        .sorted()
      StderrLog.write(
        tag: "FSWatchRegistry",
        "primary missing for commonGitDir=\(commonGitDir); dropping branchChange=\(result.hasBranchChange) remoteRefsChange=\(result.hasRemoteRefsChange) worktreeChange=\(result.hasWorktreeChange) headChange=\(result.hasHeadChange) from dir=\(dir); entries=\(siblings)"
      )
    }
    // 構造変化由来の worktreeChange: `worktrees/*` の追加 / 削除、および secondary worktree 自身の
    // branch 切替 (root watcher が `worktrees/<name>/` 配下の変化として拾う)。これは worktree list
    // の構成変化を表す path 信号で、内容 digest を経由せず即 dispatch する。main worktree の branch
    // 切替は下の digest gating の head カテゴリが担う (別経路)。
    if result.hasWorktreeChange && isPrimaryForCommonDir {
      onWorktreeChange(originalDir)
    }
    // branchChange / remoteRefsChange / worktreeChange(head) は path 分類では「ref store が動いた
    // 候補」までしか分からない。reftable backend は local / remote / HEAD を 1 テーブルに同居させ、
    // commit でも共有テーブルを書き換え、かつ `.git/HEAD` はスタブで動かないため、path だけでは
    // 「remote が動いたか」「branch が切り替わったか」を判別できない。候補が立った primary watcher で
    // `GitOps.refDigest` (for-each-ref + symbolic-ref) を読み、heads / remotes / head のうち実際に
    // 変化したカテゴリだけ dispatch する (ref backend 非依存の判定。`lastRefDigestByCommonGitDir` 参照)。
    if (result.hasBranchChange || result.hasRemoteRefsChange || result.hasHeadChange)
      && isPrimaryForCommonDir,
      let commonGitDir = entry.commonGitDir
    {
      var digest: GitOps.RefDigest? = nil
      do {
        digest = try await GitOps.refDigest(dir: dir)
      } catch {
        StderrLog.write(tag: "FSWatchRegistry", "refDigest failed for \(dir): \(error)")
      }
      // refDigest の await 中に unwatch されている可能性があるため再 check
      guard isActive(dir: dir, generation: generation) else { return }
      if let digest {
        let prev = lastRefDigestByCommonGitDir[commonGitDir]
        lastRefDigestByCommonGitDir[commonGitDir] = digest
        // 初回 (prev == nil) は baseline が無いので無条件発火し renderer と整合を取る。
        if result.hasBranchChange && prev?.heads != digest.heads {
          onBranchChange(originalDir)
        }
        if result.hasRemoteRefsChange && prev?.remotes != digest.remotes {
          onRemoteRefsChange(originalDir)
        }
        // head (symbolic-ref 先) が変われば branch 切替。main worktree の checkout 先が変わると
        // worktree list の branch 出力が変わるため worktreeChange で list refetch させる。commit は
        // head を変えない (heads の OID だけ進む) ので誤発火しない。reftable では `.git/HEAD` が
        // 動かないため、これが branch 切替を捕捉する唯一の backend 非依存経路。
        if result.hasHeadChange && prev?.head != digest.head {
          onWorktreeChange(originalDir)
        }
      } else {
        // digest 取得失敗時の fallback。candidate ごとに local-cheap signal を撃って取りこぼしを
        // 防ぎ、gh spam の元 remoteRefsChange だけは撃たない:
        //
        // 1. branchChange は候補種別に関係なく撃つ:
        //    - 外側 guard は `hasBranchChange || hasRemoteRefsChange || hasHeadChange` 候補なので、
        //      remote-only batch (`refs/remotes` だけが動いた fetch) もここに入る
        //    - `if hasBranchChange` で gate すると remote-only 候補で false になり loadLog を落とす。
        //      current 以外の branch の remote ref 変化は gitStatusChange の `branch.ab` (current 分
        //      のみ) では検知できず、branchChange だけが loadLog の回収経路
        //    - branchChange の consumer は loadLog + worktree list refetch の local のみで安価
        // 2. hasHeadChange 候補は worktreeChange を撃って branch label (worktree list) を回収する
        // 3. remoteRefsChange は撃たない (gh spam 回避。詳細は上の success path コメント /
        //    GitOps+Refs.swift 参照)。gh consumer の `loadPrList` は 60s polling で回収される
        onBranchChange(originalDir)
        if result.hasHeadChange {
          onWorktreeChange(originalDir)
        }
      }
    }

    if result.hasGitStatusChange {
      // 同一 dir の handleEvents は driving Task の serial for-await で直列化される
      // (1 dir = 1 Task = 1 ループ、`await handleEvents` の return まで次の events を取らない)。
      // よって gitStatusFull の await 中に同一 dir の別 batch が割り込み、古い実体を読んだ
      // batch が後着して新しい push を上書きする reorder は構造的に起きない。actor reentrancy
      // で割り込めるのは別 dir(別 Task)の処理のみ。再 watch を跨ぐ古い batch は下の
      // isActive(generation) が弾く。この不変条件が成立するため status 読み取りの後着破棄
      // guard は不要 (将来 handleEvents を並行起動する設計にしない限り再導入しない)。
      let status: GitOps.StatusFull
      do {
        status = try await GitOps.gitStatusFull(dir: dir)
      } catch {
        // 観察可能性のためログを残す。renderer は次の FSEvents バッチで再 fetch するため
        // 致命的ではないが、繰り返し発生していれば一時障害として診断したい。
        StderrLog.write(
          tag: "FSWatchRegistry", "gitStatusFull failed for \(dir): \(error)")
        return
      }
      // gitStatusFull の await 中に unwatch されている可能性があるため再 check
      guard isActive(dir: dir, generation: generation) else { return }
      // 内容が直近 push と同一なら push しない。gitignore 対象（ビルド成果物 /
      // node_modules 等）の書き込みは作業ツリー event として gitStatusChange を立てるが
      // git status 出力には現れず StatusFull は不変になる。typecheck / ビルド中の連射を
      // ここで止める（理由は lastPushedStatusByDir の docstring 参照）。
      if lastPushedStatusByDir[dir] == status { return }
      lastPushedStatusByDir[dir] = status
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
  /// 判定優先順位（files / reftable 両 backend をトリガーに含む。詳細は型冒頭コメント参照）:
  ///   分類は path から「ref store が動いた候補」を立てるだけで、`branchChange` /
  ///   `remoteRefsChange` / head 由来の `worktreeChange` の最終発火は dispatch 側が `RefDigest`
  ///   (heads / remotes / head) の内容比較で決める。candidate は次のとおり:
  ///   1. per-worktree git dir 配下 →
  ///      - `index` を `gitStatusChange`
  ///      - `HEAD` を `gitStatusChange`（files backend。+ main worktree / 通常 clone では
  ///        head 候補も。branch 切替で symbolic-ref 先が変わると digest の head が動き worktreeChange
  ///        を発火。reftable では HEAD スタブは動かない）
  ///      - `reftable/...` を `gitStatusChange`（reftable backend。その worktree のチェックアウト
  ///        先 ref が変わった signal）
  ///   2. common git dir 配下 →
  ///      - `refs/heads/...` を `branchChange` 候補（files backend）
  ///      - `refs/remotes/...` を `gitStatusChange` + `remoteRefsChange` 候補（files backend。
  ///        per-worktree の ahead/behind 更新と repo スコープの ref トポロジ変化を分離発火）
  ///      - `packed-refs` を `branchChange` + `gitStatusChange` + `remoteRefsChange` 候補
  ///        （files backend。local / remote 両方を含み得るため、すべてを候補に立てる）
  ///      - `reftable/...` を `branchChange` + `gitStatusChange` + `remoteRefsChange` 候補、root
  ///        (`perWtSameAsCommon`) では head 候補も（reftable backend。local / remote / HEAD が同居し
  ///        種別判別不能なため全候補を立て、実際に動いたカテゴリは digest 比較で確定。reftable は
  ///        HEAD スタブが動かず、main worktree の branch 切替を捕捉する唯一の経路がこの head 候補）
  ///      - `worktrees/...` を `worktreeChange`（worktree 追加削除 + secondary worktree の branch
  ///        切替。worktree list の構造変化を表す path 信号で、digest を経由せず即発火する）
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
    var hasRemoteRefsChange = false
    var hasWorktreeChange = false
    var hasHeadChange = false

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
        if rel == "HEAD" {
          hasGitStatusChange = true
          // perWtSameAsCommon (= main worktree / 通常 clone) のときだけ headChange 候補を立てる。
          // `.git/HEAD` の symbolic ref 先 (チェックアウト中の branch) が変わると digest の head が
          // 変化し、primary watcher が worktreeChange を発火して `git worktree list --porcelain` を
          // refetch させ、サイドバー (WtCard) の branch label を更新する。これがないと main worktree
          // (root) の branch 切替 (`git switch` 等) は gitStatusChange しか飛ばず branch label が stale。
          // worktreeChange を path で直接立てず head digest 経由にするのは、commit でも `.git/HEAD` が
          // touch される (mtime) ケースで誤発火しないよう「symbolic-ref 先が実際に変わったか」を内容で
          // 判定するため。secondary worktree は `.git/worktrees/<name>/HEAD` の変化を root watcher が
          // 下の common 規則 (`worktrees/...` → worktreeChange) で拾う (head digest は main worktree の
          // HEAD しか表さないため、secondary の切替は構造変化 worktreeChange で別途救済する)。
          // secondary 自身の watcher (perWtSameAsCommon == false) では立てない: 非 primary で digest を
          // 読まず、root watcher が構造変化 worktreeChange を出すため。
          if perWtSameAsCommon {
            hasHeadChange = true
          }
        } else if rel == "index" {
          hasGitStatusChange = true
        } else if rel.hasPrefix("reftable/") {
          // reftable backend (Git 2.51+、3.0 で default 化): per-worktree の HEAD/refs は
          // バイナリテーブル `reftable/` に格納され、`HEAD` スタブは `ref: refs/heads/.invalid`
          // の固定値で動かない。この worktree のチェックアウト先が変わると
          // `reftable/tables.list` + 新テーブルが書かれるため status を取り直す。root
          // (perWtSameAsCommon) の共有 branch/remote 変化は下の common 規則が reftable/ を拾う。
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
        } else if rel.hasPrefix("refs/remotes/") {
          // push / fetch 成功でローカルの remote-tracking ref が書き換わる。
          // - `gitStatusChange`: current branch の `# branch.ab` (ahead/behind) を更新
          // - `remoteRefsChange`: current 以外のブランチの remote ref が動いた場合の
          //   git-graph 再 load トリガ (gitStatusChange の upstream key は current branch
          //   分しか変化を載せないため、それだけでは取りこぼす)
          hasGitStatusChange = true
          hasRemoteRefsChange = true
        } else if rel == "packed-refs" {
          // pack 後は loose ref がまとめられるが、ファイル名からは local ref と
          // remote-tracking ref のどちらが書き換わったか判別できない。
          // 全 subscriber に通知する（worktree 一覧再取得 + ahead/behind 再取得 + git log 再 load）。
          hasBranchChange = true
          hasGitStatusChange = true
          hasRemoteRefsChange = true
        } else if rel.hasPrefix("reftable/") {
          // reftable backend (Git 2.51+、3.0 で default 化) の共有 ref ストア。local branch /
          // remote-tracking / HEAD が 1 つのバイナリテーブル群 (`reftable/tables.list` +
          // `*.ref`) に同居し、ファイル名から種別を判別できない (packed-refs と同じ事情)。
          // そのため branch (heads) / remote / status の候補を立て、root (perWtSameAsCommon) では
          // head 候補も立てる。これで reftable repo でも branch 切替・作成・削除・rename・fetch が
          // すべて worktree list / git-graph / status の再取得をトリガーし、files backend の
          // refs/heads・refs/remotes・packed-refs・HEAD 規則と機能的に等価になる。reftable では
          // `HEAD` スタブが動かないため、この規則が無いと branch 変化が無分類で silent drop される。
          // 実際に heads / remotes / head のどれが動いたかは primary watcher が `RefDigest` を内容
          // 比較して判定する (commit は heads のみ、push/fetch は remotes のみ、branch 切替は head の
          // み動く)。head 候補は files の `.git/HEAD` 規則と対称で、main worktree の branch 切替を
          // backend 非依存に捕捉する。secondary 自身の per-wt `reftable/*` は上の per-wt 規則
          // (gitStatusChange のみ) で処理され、その branch 切替は root watcher の `worktrees/*` 構造
          // 規則が worktreeChange として拾う。
          hasBranchChange = true
          hasGitStatusChange = true
          hasRemoteRefsChange = true
          if perWtSameAsCommon {
            hasHeadChange = true
          }
        }
      }

      if matchedGitDir { continue }

      // 作業ツリー側の変更 → fsChange (+ git dir があれば gitStatusChange)。
      // commonGitDir == nil は非 git dir の watch (例: session log dialog が監視する
      // ~/.claude/projects/<encoded>/)。git status の概念自体が無く、gitStatusChange を
      // 立てると handleEvents が `git status` を exit 128 で throw させ、ファイル変更の
      // たびに stderr へ `gitStatusFull failed` を吐いて観察ログを汚す。fsChange のみ立てる。
      guard path == dir || path.hasPrefix(dirWithSlash) else { continue }
      hasFsChange = true
      if commonGitDir != nil { hasGitStatusChange = true }
      let relDir = relativeDir(path: path, dir: dir, dirWithSlash: dirWithSlash)
      fsRelDirs.insert(relDir)
    }

    return Classification(
      fsRelDirs: fsRelDirs,
      hasFsChange: hasFsChange,
      hasGitStatusChange: hasGitStatusChange,
      hasBranchChange: hasBranchChange,
      hasRemoteRefsChange: hasRemoteRefsChange,
      hasWorktreeChange: hasWorktreeChange,
      hasHeadChange: hasHeadChange
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
