import type { WorktreeEntry } from "@gozd/proto";
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

  /** 既存 repo の worktrees / freeBranches を更新（push event 受信時の refetch 用） */
  function updateRepoData(rootDir: string, worktrees: WorktreeEntry[], freeBranches: string[]) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    repos.value[rootDir] = { ...current, worktrees, freeBranches };
  }

  function selectDir(dir: string) {
    selectedDir.value = dir;
  }

  function renameSelectedRepo(newName: string) {
    const repo = selectedRepo.value;
    if (repo === undefined) return;
    repos.value[repo.rootDir] = { ...repo, repoName: newName };
  }

  function removeRepo(rootDir: string) {
    delete repos.value[rootDir];
    dirOrder.value = dirOrder.value.filter((d) => d !== rootDir);
    if (selectedDir.value !== undefined) {
      const stillOwned = findRepoOwning(selectedDir.value);
      if (stillOwned === undefined) {
        const [firstRoot] = dirOrder.value;
        selectedDir.value = firstRoot;
      }
    }
  }

  return {
    repos,
    dirOrder,
    selectedDir,
    selectedRepo,
    selectedRepoName,
    selectedIsGitRepo,
    selectedRootDir,
    findRepoOwning,
    addRepo,
    updateRepoData,
    selectDir,
    renameSelectedRepo,
    removeRepo,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRepoStore, import.meta.hot));
}
