import type { WorktreeEntry, WorktreeRemoveRefusal } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { branchLabel, useRepoStore } from "../../../../shared/repo";
import { activateDir, useTerminalStore } from "../../../terminal";
import { rpcCreateWorktree, rpcGitWorktreeRemove } from "../../../worktree";

/** 拒否の理由ごとの確認文。強制削除で失われるものを示す。理由が重なるときは並べて示す */
const REFUSAL_MESSAGES = {
  locked: "It is locked by another tool that may still be using it.",
  submodules: "Force remove also deletes its submodules, including commits not pushed anywhere.",
  changes: "Force remove discards its modified and untracked files.",
} as const satisfies Record<WorktreeRemoveRefusal, string>;

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

  /** 新規 worktree を即座に作成する。起点 ref と名前は main 側が決める */
  async function addWorktree(rootDir: string) {
    if (creatingRootDirs.value.has(rootDir)) return;
    creatingRootDirs.value.add(rootDir);
    try {
      const result = await tryCatch(
        rpcCreateWorktree({ dir: rootDir, branch: "", startPoint: "" }),
      );
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

  /** worktree 解除: 通常削除 → 拒否・失敗時に理由を示して確認の上 --force */
  async function handleWorktreeRemove(rootDir: string, wt: WorktreeEntry) {
    const result = await tryCatch(
      rpcGitWorktreeRemove({ dir: rootDir, path: wt.path, force: false }),
    );
    const label = branchLabel(wt.branch);
    // 拒否以外の失敗（git の拒否を含む）も強制削除でしか消せないことがある（実体の無い lock 済み
    // worktree 等）。原因は通知の詳細に残し、確認文は短く保つ
    if (!result.ok) {
      notify.error(`Failed to remove "${label}"`, result.error);
      confirmForceRemove(rootDir, wt, `Failed to remove "${label}".`);
      return;
    }
    const { refused } = result.value;
    if (refused === undefined) {
      detachWorktree(rootDir, wt);
      return;
    }
    const losses = refused.map((reason) => REFUSAL_MESSAGES[reason]).join(" ");
    confirmForceRemove(rootDir, wt, `"${label}" was not removed. ${losses}`);
  }

  /** summary で強制削除の前提を示し、確認の上 --force で消す */
  function confirmForceRemove(rootDir: string, wt: WorktreeEntry, summary: string) {
    const label = branchLabel(wt.branch);
    showConfirm(`${summary} Force remove?`, async () => {
      const result = await tryCatch(
        rpcGitWorktreeRemove({ dir: rootDir, path: wt.path, force: true }),
      );
      if (result.ok) {
        detachWorktree(rootDir, wt);
        return;
      }
      notify.error(`Failed to force remove "${label}"`, result.error);
    });
  }

  return {
    isCreatingFor,
    activateDir,
    handleWorktreeSelect,
    addWorktree,
    handleWorktreeRemove,
  };
}
