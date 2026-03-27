import type { Task, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useRpc } from "../../../../shared/rpc";

interface UseTaskActionsOptions {
  fetchData: () => Promise<void>;
}

/** worktree に紐づく Task の編集・新規作成を管理する */
export function useTaskActions({ fetchData }: UseTaskActionsOptions) {
  const { request } = useRpc();

  // --- インライン編集 ---

  const editingTaskId = ref<string>();
  const editBody = ref("");

  function startEditing(task: Task) {
    editingTaskId.value = task.id;
    editBody.value = task.body;
  }

  async function saveEdit(body: string): Promise<boolean> {
    const id = editingTaskId.value;
    if (!id) return false;
    const result = await tryCatch(request.taskUpdate({ id, body }));
    if (!result.ok) return false;
    await fetchData();
    return true;
  }

  /** 保存ボタン / Enter: 編集中の body で保存してパネルを閉じる */
  async function submitEdit() {
    if (!(await saveEdit(editBody.value))) return;
    editingTaskId.value = undefined;
  }

  function cancelEdit() {
    editingTaskId.value = undefined;
  }

  // --- worktree の Task 編集・新規作成（入力欄を開き、保存時に永続化） ---

  /** Task 新規作成中の worktree ディレクトリパス */
  const addingTaskForDir = ref<string>();
  const addingTaskBody = ref("");

  /** worktree の Task 編集をトグルする。Task がなければ新規作成入力欄を開く */
  function toggleWorktreeTaskEdit(wt: WorktreeEntry) {
    // 既存 Task がある場合: 編集トグル
    if (wt.task) {
      if (editingTaskId.value === wt.task.id) {
        cancelEdit();
      } else {
        startEditing(wt.task);
      }
      return;
    }
    // Task がない場合: 新規作成入力欄のトグル
    if (addingTaskForDir.value === wt.path) {
      cancelWorktreeTaskAdd();
    } else {
      addingTaskForDir.value = wt.path;
      addingTaskBody.value = "";
    }
  }

  const isSavingWorktreeTask = ref(false);

  /** worktree の Task 新規作成を保存する */
  async function saveWorktreeTask(wt: WorktreeEntry) {
    if (isSavingWorktreeTask.value) return;
    if (!addingTaskBody.value.trim()) {
      cancelWorktreeTaskAdd();
      return;
    }
    isSavingWorktreeTask.value = true;
    const result = await tryCatch(
      request.taskAdd({ body: addingTaskBody.value, worktreeDir: wt.path }),
    );
    isSavingWorktreeTask.value = false;
    if (!result.ok) return;
    addingTaskForDir.value = undefined;
    await fetchData();
  }

  function cancelWorktreeTaskAdd() {
    addingTaskForDir.value = undefined;
  }

  return {
    // インライン編集
    editingTaskId,
    editBody,
    submitEdit,
    cancelEdit,
    // worktree Task 編集・新規作成
    addingTaskForDir,
    addingTaskBody,
    toggleWorktreeTaskEdit,
    saveWorktreeTask,
    cancelWorktreeTaskAdd,
  };
}
