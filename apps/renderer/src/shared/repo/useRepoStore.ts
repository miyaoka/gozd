import { type AppState, type Task, type UpstreamStatus, WorktreeEntry } from "@gozd/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

export interface RepoState {
  /** gozdOpen で受信した dir（git toplevel）。repos の Map キーと一致する */
  rootDir: string;
  repoName: string;
  isGitRepo: boolean;
  /** rpcGitWorktreeList の結果。Phase 6 で repoStore が直接保持するようにした */
  worktrees: WorktreeEntry[];
  /**
   * origin remote から解決した GitHub identity（repo 単位、全 worktree で共通）。
   * 未取得は undefined、非 github.com remote / remote 未設定は owner / repo が空文字。
   * sidebar の org アバターと git-graph の issue リンク base URL が共有する SSOT。
   */
  githubIdentity?: { owner: string; repo: string };
}

/**
 * `useFsWatchSync` が watch すべき dir 集合を計算する pure 関数。
 * - 各 repo の `isGitRepo` で分岐: git repo は配下の全 worktree path、非 git は rootDir 自身
 * - `useRepoStore` の computed `fsWatchTargetDirs` から呼ばれ、戻り値の `Set<string>` の
 *   `===` 比較で `watch` の再 run がトリガされる
 */
export function collectFsWatchTargetDirs(
  dirOrder: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
): Set<string> {
  const dirs = new Set<string>();
  for (const rootDir of dirOrder) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;
    if (!repo.isGitRepo) {
      dirs.add(repo.rootDir);
      continue;
    }
    for (const wt of repo.worktrees) {
      dirs.add(wt.path);
    }
  }
  return dirs;
}

/**
 * window 内で同居する全 repo を保持する。
 * - `repos` は rootDir をキーに repo メタ情報 + worktrees を持つ
 * - `selectedDir` は UI 上で選択中の worktree path（=どこかの repo の worktrees の一員）
 *   または非 git project の rootDir
 * - 非選択 repo の PTY / Claude status は terminalStore が並列保持し続ける
 */
export const useRepoStore = defineStore("repo", () => {
  const repos = ref<Record<string, RepoState>>({});
  const dirOrder = ref<string[]>([]);
  /**
   * 明示 refetch 要求。feature 層 (sidebar / picker 等) が `requestRefresh(rootDir)`
   * を呼ぶと nonce が進み、`useSidebarData` の watch 経由で `fetchRepo(rootDir)` が
   * 走る。`gitStatusChange` 等の push に依らない経路 (例: PR picker での既存 worktree
   * hit から closed_by_user な task を蘇生したいケース、task ⋮ メニューでの明示削除)
   * で SSOT を取り直すための単一信号。楽観更新 (renderer 側で `repos[...]` を直書きして
   * race を許す経路) を避ける。store には reactivity が必要なので ref で持つ。
   */
  const refreshRequest = ref<{ rootDir: string; nonce: number }>();
  function requestRefresh(rootDir: string): void {
    refreshRequest.value = { rootDir, nonce: (refreshRequest.value?.nonce ?? 0) + 1 };
  }
  /**
   * shared 層内で `selectedDir.value =` を直書きする正当な経路は以下に限定する。
   * 新たな書き換え経路を増やす前に、`worktreeStore.setOpen` 側の副作用一覧
   * （selectionVersion bump / 必要なら selection / revealVersion の同期更新）と整合
   * するか確認すること（feature 層側の責務に踏み込む変更が必要な可能性）。
   * - `selectDir()`: 通常の選択（feature 層の setOpen 経由含む）
   * - `removeRepo()`: repo まるごと削除時の fallback
   * - `updateRepoData()`: 配下 wt 削除時の rootDir fallback
   */
  const selectedDir = ref<string>();
  /** 折りたたまれている repo の rootDir 集合 */
  const collapsedRoots = ref<Set<string>>(new Set());

  /**
   * auto-fallback 発火時の通知ハンドラ。feature 層から `setAutoFallbackNotifier()` で注入する。
   * shared 間の依存禁止 + shared → feature 依存禁止のため、`useNotificationStore` を
   * 直接呼べない。`useCommandRegistry` の `setErrorHandler` と同じ DI 流儀。
   * 未設定時は console.info にフォールバックして観察可能性を最低限担保する。
   * `undefined` を渡せばリセット（HMR / unmount で旧参照を残さないため）。
   */
  let autoFallbackNotifier: ((message: string) => void) | undefined;
  function setAutoFallbackNotifier(notifier: ((message: string) => void) | undefined): void {
    autoFallbackNotifier = notifier;
  }
  function notifyAutoFallback(message: string): void {
    if (autoFallbackNotifier !== undefined) {
      autoFallbackNotifier(message);
      return;
    }
    console.info(message);
  }

  /**
   * worktree.gitStatuses の per-dir 書き込み世代。
   * `setWorktreeGitStatuses` のたびに該当 dir のカウンタを進めるため、
   * 並行する loadGitStatus / fetchRepo の RPC レスポンスは開始時の世代を覚えておき、
   * 帰ってきた時点で世代が進んでいれば「より新しい push / 個別更新が後勝ちで入った」
   * と判断して捨てる。reactivity 不要なため ref ではなく素の Map で持つ。
   */
  const gitStatusGenByDir = new Map<string, number>();
  function getGitStatusGen(dir: string): number {
    return gitStatusGenByDir.get(dir) ?? 0;
  }

  /**
   * `updateRepoData`（= `rpcGitWorktreeList` の git 真値の唯一の書き込み口）が一度でも
   * 走った rootDir の集合。`applyRepoTasks`（git 非依存の prefetch 適用）が、git 真値
   * 到達後に古い tasks.json スナップショットで上書きするのを防ぐガードに使う。
   * git 真値は tasks.json を JOIN した最新 task を含むため、真値到達後は prefetch の
   * 出番が無いという不変条件を表す。reactivity 不要なため素の Set で持つ。
   */
  const gitTruthAppliedRoots = new Set<string>();

  /** selectedDir を含む repo を逆引き。最初に dir を含む repo */
  const selectedRepo = computed(() => {
    const dir = selectedDir.value;
    if (dir === undefined) return undefined;
    for (const rootDir of dirOrder.value) {
      const repo = repos.value[rootDir];
      if (repo === undefined) continue;
      if (repo.rootDir === dir) return repo;
      if (repo.worktrees.some((wt) => wt.path === dir)) return repo;
    }
    // worktrees にまだ含まれていない（fetch 前）場合の fallback
    return repos.value[dir];
  });

  const selectedIsGitRepo = computed(() => selectedRepo.value?.isGitRepo ?? false);
  const selectedRootDir = computed(() => selectedRepo.value?.rootDir);

  /** `useFsWatchSync` が watch すべき dir 集合。`repos[*].worktrees` または非 git の rootDir */
  const fsWatchTargetDirs = computed(() => collectFsWatchTargetDirs(dirOrder.value, repos.value));

  /**
   * Claude session_id を持つ Task を全 repo / 全 worktree から逆引きする。
   * terminal の leaf → ptyId → sessionId 経由でタイトル表示するときに使う。
   * SSOT は tasks.json を JOIN した `WorktreeEntry.tasks`。空文字 sessionId は
   * 「未起動 / 切り離し済み」を意味するので呼び出し側で除外してから渡す前提。
   */
  function findTaskBySessionId(sessionId: string): Task | undefined {
    for (const rootDir of dirOrder.value) {
      const repo = repos.value[rootDir];
      if (repo === undefined) continue;
      for (const wt of repo.worktrees) {
        const task = wt.tasks.find((t) => t.sessionId === sessionId);
        if (task !== undefined) return task;
      }
    }
    return undefined;
  }

  /** dir がどこかの repo の worktrees に含まれていればその repo を返す */
  function findRepoOwning(dir: string): RepoState | undefined {
    for (const rootDir of dirOrder.value) {
      const repo = repos.value[rootDir];
      if (repo === undefined) continue;
      if (repo.rootDir === dir) return repo;
      if (repo.worktrees.some((wt) => wt.path === dir)) return repo;
    }
    return undefined;
  }

  /** `dir` が active repo (selectedDir 所属) と同じ repo を共有しているか。
   * 全 worktree watch 経路で受け取る push (`branchChange` / `remoteRefsChange` /
   * `fsWatchReady` 等) は **どの worktree が source か** に依らず「同 repo か」で active
   * 側の購読を絞りたい局面が多い。各 subscriber に同じ filter ロジックを書くと SSOT
   * 違反 (filter 方向のドリフト) を生むため、ここに集約する。
   * どちらかが未割当 / 所有 repo 不明な場合は false を返す。 */
  function isSameRepoAsActive(dir: string): boolean {
    const activeDir = selectedDir.value;
    if (activeDir === undefined) return false;
    const sourceRoot = findRepoOwning(dir)?.rootDir;
    const activeRoot = findRepoOwning(activeDir)?.rootDir;
    if (sourceRoot === undefined || activeRoot === undefined) return false;
    return sourceRoot === activeRoot;
  }

  /** 新規 repo を追加。既存ならメタ情報を上書き */
  function addRepo(state: RepoState) {
    if (!(state.rootDir in repos.value)) {
      dirOrder.value.push(state.rootDir);
    }
    repos.value[state.rootDir] = state;
  }

  /**
   * 既存 repo の worktrees を更新（rpcGitWorktreeList 結果の反映）。
   *
   * `gitStatusesGenSnapshot` には fetch 開始時に各 wt について `getGitStatusGen` で
   * 取った世代スナップショットを渡す。fetch 中に `setWorktreeGitStatuses` が走って
   * 世代が進んでいる wt については、fetch レスポンスの古い `gitStatuses` を捨てて
   * 現時点で repoStore に入っている fresher な値を保持する。
   * 渡されなかった場合は merge せず単純差し替え（hydrate / 初回登録など世代が無意味な経路）。
   */
  function updateRepoData(
    rootDir: string,
    worktrees: WorktreeEntry[],
    gitStatusesGenSnapshot?: Map<string, number>,
  ) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    let merged = worktrees;
    if (gitStatusesGenSnapshot !== undefined) {
      merged = worktrees.map((wt) => {
        const beforeGen = gitStatusesGenSnapshot.get(wt.path);
        const currentGen = gitStatusGenByDir.get(wt.path);
        if (beforeGen !== undefined && currentGen !== undefined && currentGen !== beforeGen) {
          // fetch 中に push / 単発更新が走っていた → 現値を保持。
          // `gitStatusFull` 出力の atomic snapshot 契約 (statuses / renameOldPaths /
          // upstream / latestMtime を 1 セットで扱う) に合わせ、まとめて fresher 由来に倒す。
          const fresher = current.worktrees.find((w) => w.path === wt.path);
          if (fresher !== undefined) {
            return {
              ...wt,
              gitStatuses: fresher.gitStatuses,
              renameOldPaths: fresher.renameOldPaths,
              upstream: fresher.upstream,
              latestMtime: fresher.latestMtime,
            };
          }
        }
        return wt;
      });
      // bulk 反映で touch した全 wt の世代を進める。
      // これがないと、fetchRepo 開始前から走っていた loadGitStatus が後着したとき
      // startGen と現 gen が一致してしまい、古いレスポンスが ここで採用した
      // 新スナップショットを上書きできてしまう。
      for (const wt of merged) {
        gitStatusGenByDir.set(wt.path, (gitStatusGenByDir.get(wt.path) ?? 0) + 1);
      }
    }
    // selectedDir がこの repo に属していた（current.worktrees に含まれていた）かつ
    // 更新後の worktrees から消えている場合のみ、同 repo の rootDir に倒す。これがないと
    // FilerPane / useFsWatchSync / useGitStatusSync が削除済みパスに対して
    // fs/readDir, fs/watch, git/status を投げ続け outsideDir / launchFailed エラーが出る。
    // `current.worktrees` には rpcGitWorktreeList の仕様により main rootDir 自身も含まれる
    // ため、selectedDir === rootDir のケースも自然に「属していた」と扱われる（rootDir が
    // worktree list に残り続ける限り fallback は no-op）。
    // 別 repo に属する dir が active な場合は `some` が false になるため巻き込まれない。
    //
    // path 比較は文字列完全一致で正しい。invariant: `wt.path` も `selectedDir` も
    // どちらも `git worktree list --porcelain` および `git rev-parse --show-toplevel`
    // の出力をそのまま使う。git は記録された原文の絶対パスを返すだけで symlink 解決は
    // しないが、両者とも同じ git 出力経路を踏むため文字列フォーマットは揃う（trailing
    // slash なし、git が記録した形式そのまま）。ユーザーが symlink パスで起動した場合
    // も両者が symlink を含む同一形式で一致する。
    // 新しい dir 取得経路を追加する際は必ず同じ git 出力経路を踏ませること。
    // 別形式（realpath 解決後など）を混ぜると比較が空振りして fallback が発火しなくなる。
    const orphanedActiveDir =
      selectedDir.value !== undefined &&
      current.worktrees.some((w) => w.path === selectedDir.value) &&
      !merged.some((w) => w.path === selectedDir.value);
    repos.value[rootDir] = { ...current, worktrees: merged };
    // git 真値が書かれた印。以降 applyRepoTasks（prefetch）は古い task スナップショットで
    // 上書きしない（真値は tasks.json を JOIN した最新 task を含むため出番が無い）。
    gitTruthAppliedRoots.add(rootDir);
    if (orphanedActiveDir) {
      // 外部 git worktree remove 経由だとユーザー操作なしに active dir が切り替わる。
      // feature 層が DI した notifier 経由でユーザーに通知する。未注入なら console.info。
      // 複数 repo 同時開き時にどの repo の root に切り替わったか分かるよう repoName を含める。
      // クォートを使うと repoName 内のクォート文字でメッセージが崩れるため使わない。
      // 空文字列は hydrate 経路で混入し得るので汎用ラベルにフォールバックする。
      const repoLabel = current.repoName !== "" ? current.repoName : "the repo";
      notifyAutoFallback(`Active worktree was removed; switched to ${repoLabel} root.`);
      selectedDir.value = rootDir;
    }
  }

  interface WorktreeStatusPatch {
    statuses: Record<string, string>;
    /** rename / copy エントリの 新パス → 旧パス。`statuses` と原子的に同一 patch で書く契約 (SSOT)。 */
    renameOldPaths: Record<string, string>;
    /** upstream 未設定なら undefined。`hasUpstream` のような boolean を併持しない */
    upstream: UpstreamStatus | undefined;
    /** 変更ファイルの mtime 最大値 (Unix 秒)。clean / 未取得時は 0。
     * `statuses` / `upstream` と原子的に同一 patch で書く契約 (SSOT)。 */
    latestMtime: number;
  }

  /**
   * 任意 dir に対応する worktree の gitStatuses + upstream 情報をピンポイント更新する。
   * gitStatusChange push / 単発の rpcGitStatus 結果を反映する経路で使用。
   * dir に該当する worktree が見つからなければ no-op。
   * 書き込み毎に per-dir 世代を進め、in-flight な loadGitStatus / fetchRepo の
   * 古いレスポンスがこの値を上書きできないようにする。
   *
   * **不変条件**: 呼び出しごとに `worktree` と上位 `repo` を新規オブジェクトに置き換える
   * （shallow copy）。`useGitStatusStore.gitStatuses` computed の reference 同一性を変化させ、
   * FilerPane の `watch(gitStatuses)` を確実に発火させるための SSOT。「同じ statuses なら
   * no-op で skip する」最適化を入れる場合は、watch 側を reference ベースから書き込み
   * version ref ベースに切り替える必要がある。
   */
  function setWorktreeGitStatuses(dir: string, patch: WorktreeStatusPatch) {
    const repo = findRepoOwning(dir);
    if (repo === undefined) return;
    const idx = repo.worktrees.findIndex((wt) => wt.path === dir);
    if (idx < 0) return;
    gitStatusGenByDir.set(dir, (gitStatusGenByDir.get(dir) ?? 0) + 1);
    const next = [...repo.worktrees];
    next[idx] = {
      ...next[idx],
      gitStatuses: patch.statuses,
      renameOldPaths: patch.renameOldPaths,
      upstream: patch.upstream,
      latestMtime: patch.latestMtime,
    };
    repos.value[repo.rootDir] = { ...repo, worktrees: next };
  }

  /**
   * 新規作成した worktree を repo の worktrees に追加。
   * 同一 path が既に存在する場合は no-op（store の最終防衛線として idempotent にする）。
   */
  function appendWorktree(rootDir: string, wt: WorktreeEntry) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    if (current.worktrees.some((w) => w.path === wt.path)) return;
    updateRepoData(rootDir, [...current.worktrees, wt]);
  }

  /**
   * origin remote から解決した GitHub identity を反映する（useSidebarData の fetch 経路が
   * 唯一の書き込み元）。repo 未登録なら no-op。
   */
  function setGithubIdentity(rootDir: string, identity: { owner: string; repo: string }) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    repos.value[rootDir] = { ...current, githubIdentity: identity };
  }

  function selectDir(dir: string) {
    selectedDir.value = dir;
  }

  function removeRepo(rootDir: string) {
    const removed = repos.value[rootDir];
    delete repos.value[rootDir];
    dirOrder.value = dirOrder.value.filter((d) => d !== rootDir);
    if (collapsedRoots.value.has(rootDir)) {
      const next = new Set(collapsedRoots.value);
      next.delete(rootDir);
      collapsedRoots.value = next;
    }
    // 配下 wt と rootDir 自身の世代エントリを掃除（追加削除の繰り返しでメモリが膨らまないように）
    if (removed !== undefined) {
      gitStatusGenByDir.delete(removed.rootDir);
      for (const wt of removed.worktrees) gitStatusGenByDir.delete(wt.path);
    }
    // git 真値到達フラグも掃除する。残すと同 rootDir を再追加したとき applyRepoTasks が
    // 永久 no-op になり、起動時 task 高速ロード（prefetch）の便益が失われて layout shift が
    // 一段戻る。gitStatusGenByDir と同じ per-root 補助状態として同じライフサイクルで掃除する。
    gitTruthAppliedRoots.delete(rootDir);
    if (selectedDir.value !== undefined) {
      const stillOwned = findRepoOwning(selectedDir.value);
      if (stillOwned === undefined) {
        const [firstRoot] = dirOrder.value;
        selectedDir.value = firstRoot;
      }
    }
  }

  function isCollapsed(rootDir: string): boolean {
    return collapsedRoots.value.has(rootDir);
  }

  function toggleCollapsed(rootDir: string) {
    const next = new Set(collapsedRoots.value);
    if (next.has(rootDir)) next.delete(rootDir);
    else next.add(rootDir);
    collapsedRoots.value = next;
  }

  /**
   * 折りたたみを開く（冪等）。アクティブ worktree 切り替え時に、その wt が属する repo が
   * 畳まれていても WtCard を可視化してスクロール先を作るために使う。toggle と分離するのは
   * 「既に開いている repo を閉じてしまう」副作用を構造的に排除するため（呼び出し側の意図は
   * 常に "開く" であって "トグル" ではない）。
   */
  function expand(rootDir: string) {
    if (!collapsedRoots.value.has(rootDir)) return;
    const next = new Set(collapsedRoots.value);
    next.delete(rootDir);
    collapsedRoots.value = next;
  }

  // --- 永続化サポート（I/O は feature 側で実施） ---

  /**
   * AppState の sidebar 関連フィールドを現在の store の状態で組み立てて返す。
   * shared スコープの制約により RPC 呼び出しは feature 側で行うので、
   * snapshot 構築だけここで提供する。
   */
  function buildAppStateSnapshot(): AppState {
    return {
      sidebarRepos: dirOrder.value.map((rootDir) => {
        const r = repos.value[rootDir];
        return {
          rootDir,
          repoName: r?.repoName ?? "",
          isGitRepo: r?.isGitRepo ?? false,
          collapsed: collapsedRoots.value.has(rootDir),
          // worktree キャッシュ: 起動直後の楽観カード描画に必要な最小サブセットだけ
          // 射影する。git status / tasks / upstream を含めないことで、gitStatusChange
          // push のたびに snapshot が変化して save watch が回るのを防ぐ
          // （既存 debounce 相乗り + 射影限定）。SSOT は git。
          worktrees: (r?.worktrees ?? []).map((wt) => ({
            path: wt.path,
            branch: wt.branch,
            isMain: wt.isMain,
          })),
        };
      }),
    };
  }

  /**
   * 起動時に 1 回呼ぶ。`app-state.json` から読んだ AppState を渡すと、
   * sidebar repos / order / collapsed を復元する。既に gozdOpen で追加済みの
   * repo は新規エントリとして末尾に保持する（先勝ち merge）。
   *
   * worktrees はキャッシュ（path/branch/isMain のみ）から実カードとして復元し、
   * 起動直後の layout shift を消す。git status / tasks / upstream は欠けた状態で
   * 描画され、`fetchRepo` → `updateRepoData` の真値が来たら同一 path のカードが
   * key 維持で in-place 更新される（楽観描画）。SSOT は git。
   */
  function hydrateFromAppState(state: AppState) {
    const nextRepos: Record<string, RepoState> = {};
    const nextOrder: string[] = [];
    const nextCollapsed = new Set<string>();
    for (const r of state.sidebarRepos) {
      if (r.rootDir === "") continue;
      nextRepos[r.rootDir] = {
        rootDir: r.rootDir,
        repoName: r.repoName,
        isGitRepo: r.isGitRepo,
        // キャッシュに無い残りフィールドは空で埋め、rpcGitWorktreeList の真値で上書きされる
        worktrees: r.worktrees.map(
          (wt): WorktreeEntry => ({
            path: wt.path,
            branch: wt.branch,
            isMain: wt.isMain,
            head: "",
            gitStatuses: {},
            renameOldPaths: {},
            tasks: [],
            latestMtime: 0,
          }),
        ),
        // githubIdentity は persist しない派生値（origin remote から都度解決）。
        // hydrate 前に gozdOpen → fetch 済みの repo は dirOrder が変わらず useSidebarData の
        // 新規 dir watch が再発火しないため、ここで引き継がないと再取得されない。
        githubIdentity: repos.value[r.rootDir]?.githubIdentity,
      };
      nextOrder.push(r.rootDir);
      if (r.collapsed) nextCollapsed.add(r.rootDir);
    }
    // hydrate 前に gozdOpen で追加された repo を末尾に merge
    for (const dir of dirOrder.value) {
      if (!(dir in nextRepos) && repos.value[dir]) {
        nextRepos[dir] = repos.value[dir];
        nextOrder.push(dir);
      }
    }
    repos.value = nextRepos;
    dirOrder.value = nextOrder;
    collapsedRoots.value = nextCollapsed;
  }

  /**
   * git 非依存で読んだ task 一覧（`rpcTaskList`）を、既存 worktrees に worktreeDir で
   * 割り当てる。起動直後、worktree キャッシュから描画したカードに task 行を即埋める高速
   * 経路。各 wt は spread で gitStatuses / upstream 等を保持し、tasks のみ差し替える。
   * `updateRepoData` で git 真値が既に書かれた repo は no-op にする。prefetch と fetchRepo
   * は並走起動され完了順序は保証されない。fetchRepo が先に完了したケースで、prefetch の
   * 古い tasks.json スナップショット（往復中に session hook 等で task が増えた場合、真値
   * より古い）が後着して真値の task を消す race を構造的に塞ぐ。git 真値到達後は prefetch
   * の出番が無い（真値が tasks.json を JOIN した最新 task を含む）。task の SSOT は tasks.json。
   */
  function applyRepoTasks(rootDir: string, tasks: Task[]) {
    if (gitTruthAppliedRoots.has(rootDir)) return;
    const current = repos.value[rootDir];
    if (current === undefined) return;
    repos.value[rootDir] = {
      ...current,
      worktrees: current.worktrees.map((wt) => ({
        ...wt,
        tasks: tasks.filter((t) => t.worktreeDir === wt.path),
      })),
    };
  }

  return {
    repos,
    dirOrder,
    selectedDir,
    selectedRepo,
    selectedIsGitRepo,
    selectedRootDir,
    fsWatchTargetDirs,
    collapsedRoots,
    findRepoOwning,
    findTaskBySessionId,
    isSameRepoAsActive,
    addRepo,
    updateRepoData,
    applyRepoTasks,
    setWorktreeGitStatuses,
    setGithubIdentity,
    getGitStatusGen,
    appendWorktree,
    selectDir,
    removeRepo,
    isCollapsed,
    toggleCollapsed,
    expand,
    buildAppStateSnapshot,
    hydrateFromAppState,
    setAutoFallbackNotifier,
    refreshRequest,
    requestRefresh,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRepoStore, import.meta.hot));
}
