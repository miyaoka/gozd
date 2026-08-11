import type { WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp } from "../../../worktree";
import { activateDir } from "../../activateDir";
import { rpcCreateWorktree, rpcGitDefaultBranch, rpcGitWorktreeRemove } from "../../rpc";
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
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();

  const creatingRootDirs = ref(new Set<string>());

  function handleWorktreeSelect(wt: WorktreeEntry) {
    activateDir(wt.path);
  }

  // --- store 更新 helpers ---

  function detachWorktree(rootDir: string, wt: WorktreeEntry) {
    const repo = repoStore.repos[rootDir];
    if (!repo) return;
    const newWorktrees = repo.worktrees.filter((w) => w.path !== wt.path);
    repoStore.updateRepoData(rootDir, newWorktrees);
    terminalStore.remove(wt.path);
  }

  // --- 作成・削除 ---

  /** タイムスタンプで即座に新規 worktree を作成する（Task なし） */
  async function addWorktree(rootDir: string) {
    if (creatingRootDirs.value.has(rootDir)) return;
    creatingRootDirs.value.add(rootDir);
    try {
      // default branch を起点にする。main 側で `origin/HEAD` を優先し、未設定
      // （remote 無し / push 前 repo）の場合は main repo root 自身の current branch に
      // fallback した ref を受け取り、`startPoint` に渡す。
      const branchResult = await tryCatch(rpcGitDefaultBranch({ dir: rootDir }));
      if (!branchResult.ok || branchResult.value.branch === "") {
        notify.error(
          "Failed to resolve default branch",
          branchResult.ok ? undefined : branchResult.error,
        );
        return;
      }
      const timestamp = generateTimestamp();
      const result = await tryCatch(
        rpcCreateWorktree({
          dir: rootDir,
          worktreeDir: timestamp,
          branch: timestamp,
          startPoint: branchResult.value.branch,
        }),
      );
      if (result.ok && result.value.worktree !== undefined) {
        repoStore.appendWorktree(rootDir, result.value.worktree);
        // setOpen（activateDir 内）が visit を駆動する前に setup ヒントを立てる
        terminalStore.setPreferredSetup(result.value.dir, result.value.setupScript);
        activateDir(result.value.dir);
      } else {
        notify.error("Failed to add worktree", result.ok ? undefined : result.error);
      }
    } finally {
      creatingRootDirs.value.delete(rootDir);
    }
  }

  function isCreatingFor(rootDir: string): boolean {
    return creatingRootDirs.value.has(rootDir);
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
    isCreatingFor,
    activateDir,
    handleWorktreeSelect,
    addWorktree,
    handleWorktreeRemove,
  };
}
