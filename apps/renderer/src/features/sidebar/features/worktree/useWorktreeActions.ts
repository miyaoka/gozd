import type { WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { activateDir, useTerminalStore } from "../../../terminal";
import { rpcCreateWorktree, rpcGitWorktreeRemove } from "../../../worktree";
import { worktreeDisplayName } from "../../utils";

interface UseWorktreeActionsOptions {
  showConfirm: (message: string, action: () => Promise<void>) => void;
}

/**
 * Worktree の作成・削除・選択。
 *
 * すべての書き込み系操作は `rootDir` を明示的に受け取り、対象 repo を一意に特定する。
 * `worktreeStore.dir`（active）には依存しない。作成後の掲載先だけは応答の `rootDir` から引く
 * （main が解決した値と store のキーが一致しないことがあるため）。
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

  /** 新規 worktree を即座に作成する（Task なし）。起点 ref と名前は main 側が決める */
  async function addWorktree(rootDir: string) {
    if (creatingRootDirs.value.has(rootDir)) return;
    creatingRootDirs.value.add(rootDir);
    try {
      const result = await tryCatch(rpcCreateWorktree({ dir: rootDir }));
      if (result.ok && result.value.worktree !== undefined) {
        // 掲載先は store が持つ repo のキーで指す。main が返す rootDir は realpath 解決済みの
        // main repo root で、store のキーと一致しないことがある。引けないまま activate すると
        // サイドバーに出ない worktree でターミナルだけが動くので、通知して止める
        const owning = repoStore.findRepoOwning(result.value.rootDir);
        if (owning === undefined) {
          notify.error("Worktree created but sidebar could not be updated");
          return;
        }
        repoStore.appendWorktree(owning.rootDir, result.value.worktree);
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
