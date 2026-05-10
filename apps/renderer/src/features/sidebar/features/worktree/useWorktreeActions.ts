import type { WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { rpcCreateWorktree, rpcGitWorktreeRemove } from "../../rpc";
import { worktreeDisplayName } from "../../utils";

interface UseWorktreeActionsOptions {
  showConfirm: (message: string, action: () => Promise<void>) => void;
}

/**
 * Worktree の作成・削除・選択。
 *
 * すべての書き込み系操作は `rootDir` を明示的に受け取り、対象 repo を一意に特定する。
 * `worktreeStore.dir`（active）には依存しない。
 */
export function useWorktreeActions({ showConfirm }: UseWorktreeActionsOptions) {
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();

  const isCreating = ref(false);

  function isActive(wt: WorktreeEntry): boolean {
    return worktreeStore.dir === wt.path;
  }

  function handleWorktreeSelect(wt: WorktreeEntry) {
    terminalStore.viewMode = "wt";
    if (isActive(wt)) {
      terminalStore.clearDoneStates(wt.path);
      return;
    }
    worktreeStore.setOpen(wt.path);
  }

  // --- store 更新 helpers ---

  function detachWorktree(rootDir: string, wt: WorktreeEntry) {
    const repo = repoStore.repos[rootDir];
    if (!repo) return;
    const newWorktrees = repo.worktrees.filter((w) => w.path !== wt.path);
    const newFreeBranches = wt.branch ? [...repo.freeBranches, wt.branch] : repo.freeBranches;
    repoStore.updateRepoData(rootDir, newWorktrees, newFreeBranches);
    terminalStore.remove(wt.path);
  }

  function takeFreeBranch(rootDir: string, branch: string) {
    const repo = repoStore.repos[rootDir];
    if (!repo) return;
    repoStore.updateRepoData(
      rootDir,
      repo.worktrees,
      repo.freeBranches.filter((b) => b !== branch),
    );
  }

  function returnFreeBranch(rootDir: string, branch: string) {
    const repo = repoStore.repos[rootDir];
    if (!repo) return;
    repoStore.updateRepoData(rootDir, repo.worktrees, [...repo.freeBranches, branch]);
  }

  // --- 作成・削除 ---

  /** タイムスタンプで即座に新規 worktree を作成する（Task なし） */
  async function addWorktree(rootDir: string) {
    if (isCreating.value) return;
    isCreating.value = true;
    const timestamp = generateTimestamp();
    const result = await tryCatch(
      rpcCreateWorktree({
        dir: rootDir,
        worktreeDir: timestamp,
        branch: timestamp,
        startPoint: "HEAD",
      }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      repoStore.appendWorktree(rootDir, result.value.worktree);
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir);
    } else {
      notify.error("Failed to add worktree", result.ok ? undefined : result.error);
    }
    isCreating.value = false;
  }

  /** 既存ブランチを worktree 化する */
  async function handleBranchLink(rootDir: string, branch: string) {
    if (isCreating.value) return;
    isCreating.value = true;
    takeFreeBranch(rootDir, branch);
    const result = await tryCatch(
      rpcCreateWorktree({
        dir: rootDir,
        worktreeDir: generateTimestamp(),
        branch,
        startPoint: "",
      }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      repoStore.appendWorktree(rootDir, result.value.worktree);
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir);
    } else {
      notify.error("Failed to create worktree", result.ok ? undefined : result.error);
      returnFreeBranch(rootDir, branch);
    }
    isCreating.value = false;
  }

  /** worktree 解除: 通常削除 → 失敗時に確認の上 --force */
  async function handleWorktreeRemove(rootDir: string, wt: WorktreeEntry) {
    const result = await tryCatch(
      rpcGitWorktreeRemove({ dir: rootDir, path: wt.path, force: false }),
    );
    if (result.ok) {
      detachWorktree(rootDir, wt);
      return;
    }
    showConfirm(
      `Failed to remove "${worktreeDisplayName(wt)}" (may have uncommitted changes). Force remove?`,
      async () => {
        const forceResult = await tryCatch(
          rpcGitWorktreeRemove({ dir: rootDir, path: wt.path, force: true }),
        );
        if (forceResult.ok) {
          detachWorktree(rootDir, wt);
        } else {
          notify.error(`Failed to force remove "${worktreeDisplayName(wt)}"`, forceResult.error);
        }
      },
    );
  }

  return {
    isCreating,
    isActive,
    handleWorktreeSelect,
    addWorktree,
    handleWorktreeRemove,
    handleBranchLink,
  };
}
