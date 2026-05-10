import { AppState, type WorktreeEntry } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

interface RepoState {
  /** gozdOpen で受信した dir（git toplevel）。repos の Map キーと一致する */
  rootDir: string;
  repoName: string;
  isGitRepo: boolean;
  /** rpcGitWorktreeList の結果。Phase 6 で repoStore が直接保持するようにした */
  worktrees: WorktreeEntry[];
  /** worktree 化されていないローカルブランチ */
  freeBranches: string[];
}

/**
 * window 内で同居する全 repo を保持する。
 * - `repos` は rootDir をキーに repo メタ情報 + worktrees / freeBranches を持つ
 * - `selectedDir` は UI 上で選択中の worktree path（=どこかの repo の worktrees の一員）
 *   または非 git project の rootDir
 * - 非選択 repo の PTY / Claude status は terminalStore が並列保持し続ける
 */
export const useRepoStore = defineStore("repo", () => {
  const repos = ref<Record<string, RepoState>>({});
  const dirOrder = ref<string[]>([]);
  const selectedDir = ref<string>();
  /** 折りたたまれている repo の rootDir 集合 */
  const collapsedRoots = ref<Set<string>>(new Set());

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

  const selectedRepoName = computed(() => selectedRepo.value?.repoName);
  const selectedIsGitRepo = computed(() => selectedRepo.value?.isGitRepo ?? false);
  const selectedRootDir = computed(() => selectedRepo.value?.rootDir);

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

  /** 新規 repo を追加。既存ならメタ情報を上書き */
  function addRepo(state: RepoState) {
    if (!(state.rootDir in repos.value)) {
      dirOrder.value.push(state.rootDir);
    }
    repos.value[state.rootDir] = state;
  }

  /**
   * 既存 repo の worktrees / freeBranches を更新（rpcGitWorktreeList 結果の反映）。
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
    freeBranches: string[],
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
          // fetch 中に push / 単発更新が走っていた → 現値を保持
          const fresher = current.worktrees.find((w) => w.path === wt.path);
          if (fresher !== undefined) {
            return { ...wt, gitStatuses: fresher.gitStatuses };
          }
        }
        return wt;
      });
    }
    repos.value[rootDir] = { ...current, worktrees: merged, freeBranches };
  }

  /**
   * 任意 dir に対応する worktree の gitStatuses だけをピンポイント更新する。
   * gitStatusChange push / 単発の rpcGitStatus 結果を反映する経路で使用。
   * dir に該当する worktree が見つからなければ no-op。
   * 書き込み毎に per-dir 世代を進め、in-flight な loadGitStatus / fetchRepo の
   * 古いレスポンスがこの値を上書きできないようにする。
   */
  function setWorktreeGitStatuses(dir: string, statuses: Record<string, string>) {
    const repo = findRepoOwning(dir);
    if (repo === undefined) return;
    const idx = repo.worktrees.findIndex((wt) => wt.path === dir);
    if (idx < 0) return;
    gitStatusGenByDir.set(dir, (gitStatusGenByDir.get(dir) ?? 0) + 1);
    const next = [...repo.worktrees];
    next[idx] = { ...next[idx], gitStatuses: statuses };
    repos.value[repo.rootDir] = { ...repo, worktrees: next };
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

  // --- 永続化サポート（I/O は feature 側で実施） ---

  /**
   * load した state のうち sidebar 以外のフィールド（windowFrame 等）を保持し、
   * save 時に同じ値を書き戻すための pass-through buffer。
   */
  let cachedBaseState: AppState = AppState.fromJSON({});

  /**
   * AppState の sidebar 関連フィールドを現在の store の状態で組み立てて返す。
   * shared スコープの制約により RPC 呼び出しは feature 側で行うので、
   * snapshot 構築だけここで提供する。
   */
  function buildAppStateSnapshot(): AppState {
    return {
      ...cachedBaseState,
      lastOpenedDir: selectedDir.value ?? cachedBaseState.lastOpenedDir,
      sidebarRepos: dirOrder.value.map((rootDir) => {
        const r = repos.value[rootDir];
        return {
          rootDir,
          repoName: r?.repoName ?? "",
          isGitRepo: r?.isGitRepo ?? false,
          collapsed: collapsedRoots.value.has(rootDir),
        };
      }),
    };
  }

  /**
   * 起動時に 1 回呼ぶ。`app-state.json` から読んだ AppState を渡すと、
   * sidebar repos / order / collapsed を復元する。既に gozdOpen で追加済みの
   * repo は新規エントリとして末尾に保持する（先勝ち merge）。
   */
  function hydrateFromAppState(state: AppState) {
    cachedBaseState = state;
    const nextRepos: Record<string, RepoState> = {};
    const nextOrder: string[] = [];
    const nextCollapsed = new Set<string>();
    for (const r of state.sidebarRepos) {
      if (r.rootDir === "") continue;
      nextRepos[r.rootDir] = {
        rootDir: r.rootDir,
        repoName: r.repoName,
        isGitRepo: r.isGitRepo,
        worktrees: [],
        freeBranches: [],
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

  return {
    repos,
    dirOrder,
    selectedDir,
    selectedRepo,
    selectedRepoName,
    selectedIsGitRepo,
    selectedRootDir,
    collapsedRoots,
    findRepoOwning,
    addRepo,
    updateRepoData,
    setWorktreeGitStatuses,
    getGitStatusGen,
    selectDir,
    removeRepo,
    isCollapsed,
    toggleCollapsed,
    buildAppStateSnapshot,
    hydrateFromAppState,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRepoStore, import.meta.hot));
}
