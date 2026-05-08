import type { Task, WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { useTerminalStore } from "../../../terminal";
import { useWorktreeStore, generateTimestamp } from "../../../worktree";
import { rpcCreateWorktree, rpcCreateWorktreeWithTask, rpcGitWorktreeRemove } from "../../rpc";
import { worktreeDisplayName } from "../../utils";

interface UseWorktreeActionsOptions {
  showConfirm: (message: string, action: () => Promise<void>) => void;
}

/**
 * Worktree の作成・削除・選択・切り替え。
 * 状態は repoStore に対して更新する（useSidebarData 経由ではなく直接 repoStore を操作）。
 */
export function useWorktreeActions({ showConfirm }: UseWorktreeActionsOptions) {
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();

  const isCreating = ref(false);
  const isSwitching = ref(false);

  /** 選択中 repo の worktrees に新規追加して repoStore を更新 */
  function appendWorktree(worktree: WorktreeEntry) {
    const repo = repoStore.selectedRepo;
    if (repo === undefined) return;
    repoStore.updateRepoData(repo.rootDir, [...repo.worktrees, worktree], repo.freeBranches);
  }

  /** worktree を選択中 repo の worktrees から除去し、必要なら freeBranches に戻す */
  function detachWorktree(wt: WorktreeEntry) {
    const repo = repoStore.selectedRepo;
    if (repo === undefined) return;
    const newWorktrees = repo.worktrees.filter((w) => w.path !== wt.path);
    const newFreeBranches = wt.branch ? [...repo.freeBranches, wt.branch] : repo.freeBranches;
    repoStore.updateRepoData(repo.rootDir, newWorktrees, newFreeBranches);
    terminalStore.remove(wt.path);
  }

  /** branch を一時的に freeBranches から取り除く（rpcCreateWorktree 失敗時に戻す） */
  function takeFreeBranch(branch: string) {
    const repo = repoStore.selectedRepo;
    if (repo === undefined) return;
    repoStore.updateRepoData(
      repo.rootDir,
      repo.worktrees,
      repo.freeBranches.filter((b) => b !== branch),
    );
  }

  function returnFreeBranch(branch: string) {
    const repo = repoStore.selectedRepo;
    if (repo === undefined) return;
    repoStore.updateRepoData(repo.rootDir, repo.worktrees, [...repo.freeBranches, branch]);
  }

  // --- worktree 操作 ---

  /** 現在表示中の worktree かどうか */
  function isActive(wt: WorktreeEntry): boolean {
    return worktreeStore.dir === wt.path;
  }

  /** worktree をクリックして表示対象を切り替える */
  async function handleWorktreeSelect(wt: WorktreeEntry) {
    terminalStore.viewMode = "wt";
    if (isActive(wt)) {
      terminalStore.clearDoneStates(wt.path);
      return;
    }
    if (isSwitching.value) return;
    isSwitching.value = true;
    worktreeStore.setOpen(wt.path);
    isSwitching.value = false;
  }

  async function createWorktree(branch: string) {
    if (isCreating.value) return;
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    isCreating.value = true;
    takeFreeBranch(branch);

    const result = await tryCatch(
      rpcCreateWorktree({ dir, worktreeDir: generateTimestamp(), branch, startPoint: "" }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      appendWorktree(result.value.worktree);
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir);
    } else {
      notify.error("Failed to create worktree", result.ok ? undefined : result.error);
      returnFreeBranch(branch);
    }
    isCreating.value = false;
  }

  /** worktree 解除: まず通常削除、失敗したら確認後 --force */
  async function handleWorktreeRemove(wt: WorktreeEntry) {
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    const result = await tryCatch(rpcGitWorktreeRemove({ dir, path: wt.path, force: false }));
    if (result.ok) {
      detachWorktree(wt);
      return;
    }
    showConfirm(
      `Failed to remove "${worktreeDisplayName(wt)}" (may have uncommitted changes). Force remove?`,
      async () => {
        const forceResult = await tryCatch(
          rpcGitWorktreeRemove({ dir, path: wt.path, force: true }),
        );
        if (forceResult.ok) {
          detachWorktree(wt);
        } else {
          notify.error(`Failed to force remove "${worktreeDisplayName(wt)}"`, forceResult.error);
        }
      },
    );
  }

  async function createWorktreeWithTask({
    task,
    worktreeDir,
    branch,
  }: {
    task: Task;
    worktreeDir: string;
    branch: string;
  }) {
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    isCreating.value = true;
    const result = await tryCatch(
      rpcCreateWorktreeWithTask({ dir, id: task.id, worktreeDir, branch }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      appendWorktree(result.value.worktree);
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir);
    } else {
      notify.error("Failed to create worktree with task", result.ok ? undefined : result.error);
    }
    isCreating.value = false;
  }

  /** タイムスタンプで即座に worktree を作成する（Task なし） */
  async function addWorktree() {
    if (isCreating.value) return;
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    isCreating.value = true;
    const timestamp = generateTimestamp();
    const result = await tryCatch(
      rpcCreateWorktree({ dir, worktreeDir: timestamp, branch: timestamp, startPoint: "HEAD" }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      appendWorktree(result.value.worktree);
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir);
    } else {
      notify.error("Failed to add worktree", result.ok ? undefined : result.error);
    }
    isCreating.value = false;
  }

  /** ブランチを worktree 化する */
  function handleBranchLink(branch: string) {
    void createWorktree(branch);
  }

  return {
    isCreating,
    isSwitching,
    isActive,
    handleWorktreeSelect,
    addWorktree,
    createWorktree,
    handleWorktreeRemove,
    createWorktreeWithTask,
    handleBranchLink,
  };
}
