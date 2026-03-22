import type { Todo, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import type { Ref } from "vue";
import { ref } from "vue";
import { useRpc } from "../../../../shared/rpc";
import { useDiagnosticsStore } from "../../../diagnostics";
import { useTerminalStore } from "../../../terminal";
import { useWorktreeStore } from "../../../worktree";
import { generateTimestamp, worktreeDisplayName } from "../../utils";

interface UseWorktreeActionsOptions {
  worktrees: Ref<WorktreeEntry[]>;
  freeBranches: Ref<string[]>;
  fetchData: () => Promise<void>;
  showConfirm: (message: string, action: () => Promise<void>) => void;
  showAlert: (message: string) => void;
}

/**
 * Worktree の作成・削除・選択・切り替え。
 * isCreating / isSwitching を独立管理し、re-entry guard を提供する。
 */
export function useWorktreeActions({
  worktrees,
  freeBranches,
  fetchData,
  showConfirm,
  showAlert,
}: UseWorktreeActionsOptions) {
  const worktreeStore = useWorktreeStore();
  const diagnosticsStore = useDiagnosticsStore();
  const terminalStore = useTerminalStore();
  const { request } = useRpc();

  const isCreating = ref(false);
  const isSwitching = ref(false);

  // --- 新規 Worktree 作成パネル ---

  const isAddingWorktree = ref(false);
  const newWorktreeBody = ref("");
  const newWorktreeIcon = ref<string>();
  /** worktree のディレクトリ名・ブランチ名（パネル表示時に確定） */
  const newWorktreeDir = ref("");

  function startAddingWorktree() {
    isAddingWorktree.value = true;
    const id = generateTimestamp();
    newWorktreeDir.value = id;
    newWorktreeBody.value = id;
    newWorktreeIcon.value = undefined;
  }

  async function submitNewWorktree() {
    if (!newWorktreeBody.value.trim()) {
      isAddingWorktree.value = false;
      return;
    }
    if (isCreating.value) return;
    isCreating.value = true;
    const addResult = await tryCatch(
      request.todoAdd({ body: newWorktreeBody.value, icon: newWorktreeIcon.value }),
    );
    if (!addResult.ok) {
      isCreating.value = false;
      return;
    }
    isAddingWorktree.value = false;
    // worktree 作成が失敗しても Todo は作成済み。TODOS 欄に表示される
    await createWorktreeWithTodo({
      todo: addResult.value,
      worktreeDir: newWorktreeDir.value,
      branch: newWorktreeDir.value,
    });
  }

  function cancelNewWorktree() {
    isAddingWorktree.value = false;
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
    const result = await tryCatch(request.switchDir({ dir: wt.path }));
    if (result.ok) {
      diagnosticsStore.clear();
      worktreeStore.setOpen(result.value.dir, undefined, result.value.fileServerBaseUrl);
    }
    isSwitching.value = false;
  }

  async function createWorktree(branch: string) {
    if (isCreating.value) return;
    isCreating.value = true;
    freeBranches.value = freeBranches.value.filter((b) => b !== branch);

    const result = await tryCatch(
      request.createWorktree({ worktreeDir: generateTimestamp(), branch }),
    );
    if (result.ok) {
      await fetchData();
    } else {
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
    const result = await tryCatch(request.gitWorktreeRemove({ path: wt.path }));
    if (result.ok) {
      removeFromList(wt);
      return;
    }
    showConfirm(
      `Failed to remove "${worktreeDisplayName(wt)}" (may have uncommitted changes). Force remove?`,
      async () => {
        const forceResult = await tryCatch(
          request.gitWorktreeRemove({ path: wt.path, force: true }),
        );
        if (forceResult.ok) {
          removeFromList(wt);
        } else {
          showAlert(`Failed to force remove "${worktreeDisplayName(wt)}".`);
        }
      },
    );
  }

  async function createWorktreeWithTodo({
    todo,
    worktreeDir,
    branch,
  }: {
    todo: Todo;
    worktreeDir: string;
    branch: string;
  }) {
    isCreating.value = true;
    // 失敗しても Todo は残る。fetchData で TODOS 欄に反映され、再試行または削除できる
    await tryCatch(request.createWorktreeWithTodo({ id: todo.id, worktreeDir, branch }));
    await fetchData();
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
    createWorktree,
    handleWorktreeRemove,
    createWorktreeWithTodo,
    handleBranchLink,
    // 新規作成パネル
    isAddingWorktree,
    newWorktreeBody,
    newWorktreeIcon,
    newWorktreeDir,
    startAddingWorktree,
    submitNewWorktree,
    cancelNewWorktree,
  };
}
