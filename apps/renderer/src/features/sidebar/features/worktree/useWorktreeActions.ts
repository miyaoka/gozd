import type { Task, WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import type { Ref } from "vue";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useTerminalStore } from "../../../terminal";
import { useWorktreeStore, generateTimestamp } from "../../../worktree";
import { rpcCreateWorktree, rpcCreateWorktreeWithTask, rpcGitWorktreeRemove } from "../../rpc";
import { worktreeDisplayName } from "../../utils";

interface UseWorktreeActionsOptions {
  worktrees: Ref<WorktreeEntry[]>;
  freeBranches: Ref<string[]>;
  showConfirm: (message: string, action: () => Promise<void>) => void;
}

/**
 * Worktree の作成・削除・選択・切り替え。
 * isCreating / isSwitching を独立管理し、re-entry guard を提供する。
 */
export function useWorktreeActions({
  worktrees,
  freeBranches,
  showConfirm,
}: UseWorktreeActionsOptions) {
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();

  const isCreating = ref(false);
  const isSwitching = ref(false);

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
    // 新 RPC ではサーバー側 switchDir はステートレス化により廃止。worktreeStore.dir を直接更新する。
    worktreeStore.setOpen(wt.path, undefined, undefined);
    isSwitching.value = false;
  }

  async function createWorktree(branch: string) {
    if (isCreating.value) return;
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    isCreating.value = true;
    freeBranches.value = freeBranches.value.filter((b) => b !== branch);

    const result = await tryCatch(
      rpcCreateWorktree({ dir, worktreeDir: generateTimestamp(), branch, startPoint: "" }),
    );
    if (result.ok && result.value.worktree !== undefined) {
      worktrees.value = [...worktrees.value, result.value.worktree];
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir, undefined, undefined);
    } else {
      notify.error("Failed to create worktree", result.ok ? undefined : result.error);
      freeBranches.value.push(branch);
    }
    isCreating.value = false;
  }

  function removeFromList(wt: WorktreeEntry) {
    worktrees.value = worktrees.value.filter((w) => w.path !== wt.path);
    // ブランチが残る場合は freeBranches に戻す
    if (wt.branch) {
      freeBranches.value.push(wt.branch);
    }
    // ターミナルの visitedDirs から除去（leaf / PTY を破棄させる）
    terminalStore.remove(wt.path);
  }

  /** worktree 解除: まず通常削除、失敗したら確認後 --force */
  async function handleWorktreeRemove(wt: WorktreeEntry) {
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    const result = await tryCatch(rpcGitWorktreeRemove({ dir, path: wt.path, force: false }));
    if (result.ok) {
      removeFromList(wt);
      return;
    }
    showConfirm(
      `Failed to remove "${worktreeDisplayName(wt)}" (may have uncommitted changes). Force remove?`,
      async () => {
        const forceResult = await tryCatch(
          rpcGitWorktreeRemove({ dir, path: wt.path, force: true }),
        );
        if (forceResult.ok) {
          removeFromList(wt);
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
      worktrees.value = [...worktrees.value, result.value.worktree];
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir, undefined, undefined);
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
      worktrees.value = [...worktrees.value, result.value.worktree];
      terminalStore.viewMode = "wt";
      worktreeStore.setOpen(result.value.dir, undefined, undefined);
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
    // worktree 操作
    handleWorktreeSelect,
    addWorktree,
    createWorktree,
    handleWorktreeRemove,
    createWorktreeWithTask,
    handleBranchLink,
  };
}
