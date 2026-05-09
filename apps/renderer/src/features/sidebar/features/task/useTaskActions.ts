import type { Task, WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { rpcTaskAdd, rpcTaskUpdate } from "../../rpc";

interface UseTaskActionsOptions {
  fetchRepo: (rootDir: string) => Promise<void>;
}

/**
 * worktree に紐づく Task の編集・新規作成。
 *
 * 編集 / 追加開始時に rootDir を捕捉し、保存時にその rootDir を Project dir として使う。
 * これにより、active 以外の repo の worktree でも独立に Task を編集できる。
 */
export function useTaskActions({ fetchRepo }: UseTaskActionsOptions) {
  // --- 既存 Task のインライン編集 ---

  const editingTaskId = ref<string>();
  const editingRootDir = ref<string>();
  const editBody = ref("");

  function startEditing(task: Task, rootDir: string) {
    editingTaskId.value = task.id;
    editingRootDir.value = rootDir;
    editBody.value = task.body;
  }

  function cancelEdit() {
    editingTaskId.value = undefined;
    editingRootDir.value = undefined;
  }

  async function submitEdit() {
    const id = editingTaskId.value;
    const rootDir = editingRootDir.value;
    if (id === undefined || rootDir === undefined) return;
    const result = await tryCatch(rpcTaskUpdate({ dir: rootDir, id, body: editBody.value }));
    if (!result.ok) return;
    await fetchRepo(rootDir);
    cancelEdit();
  }

  // --- worktree への Task 新規作成 ---

  /** Task 新規作成中の worktree path（一度に 1 件のみ） */
  const addingTaskForDir = ref<string>();
  const addingTaskRootDir = ref<string>();
  const addingTaskBody = ref("");
  const isSavingWorktreeTask = ref(false);

  function cancelWorktreeTaskAdd() {
    addingTaskForDir.value = undefined;
    addingTaskRootDir.value = undefined;
  }

  /** Task の編集 / 新規作成入力欄をトグル */
  function toggleWorktreeTaskEdit(wt: WorktreeEntry, rootDir: string) {
    if (wt.task) {
      if (editingTaskId.value === wt.task.id) cancelEdit();
      else startEditing(wt.task, rootDir);
      return;
    }
    if (addingTaskForDir.value === wt.path) {
      cancelWorktreeTaskAdd();
      return;
    }
    addingTaskForDir.value = wt.path;
    addingTaskRootDir.value = rootDir;
    addingTaskBody.value = "";
  }

  async function saveWorktreeTask(wt: WorktreeEntry) {
    if (isSavingWorktreeTask.value) return;
    if (!addingTaskBody.value.trim()) {
      cancelWorktreeTaskAdd();
      return;
    }
    const rootDir = addingTaskRootDir.value;
    if (rootDir === undefined) return;

    isSavingWorktreeTask.value = true;
    const result = await tryCatch(
      rpcTaskAdd({
        dir: rootDir,
        body: addingTaskBody.value,
        worktreeDir: wt.path,
        prNumber: 0,
        issueNumber: 0,
      }),
    );
    isSavingWorktreeTask.value = false;
    if (!result.ok) return;
    cancelWorktreeTaskAdd();
    await fetchRepo(rootDir);
  }

  return {
    editingTaskId,
    editBody,
    submitEdit,
    cancelEdit,
    addingTaskForDir,
    addingTaskBody,
    toggleWorktreeTaskEdit,
    saveWorktreeTask,
    cancelWorktreeTaskAdd,
  };
}
