import type { Todo } from "@orkis/rpc";
import { tryCatch } from "@orkis/shared";
import { ref } from "vue";

interface TodoEditDeps {
  request: {
    todoUpdate: (params: { id: string; body: string; icon?: string }) => Promise<Todo>;
    todoAdd: (params: { body: string; icon?: string; worktreeDir?: string }) => Promise<Todo>;
  };
  fetchData: () => Promise<void>;
}

export function useTodoEdit({ request, fetchData }: TodoEditDeps) {
  // --- インライン編集 ---

  const editingTodoId = ref<string>();
  const editBody = ref("");
  const editIcon = ref<string>();
  /** 保存済みの body（アイコンのみ保存時に使用） */
  const savedBody = ref("");

  function startEditing(todo: Todo) {
    editingTodoId.value = todo.id;
    editBody.value = todo.body;
    editIcon.value = todo.icon;
    savedBody.value = todo.body;
  }

  async function saveEdit(body: string): Promise<boolean> {
    const id = editingTodoId.value;
    if (!id) return false;
    const result = await tryCatch(request.todoUpdate({ id, body, icon: editIcon.value }));
    if (!result.ok) return false;
    await fetchData();
    return true;
  }

  /** アイコン変更時: 編集前の body とマージして保存 */
  function saveEditIcon() {
    void saveEdit(savedBody.value);
  }

  /** 保存ボタン / Enter: 編集中の body で保存してパネルを閉じる */
  async function submitEdit() {
    if (!(await saveEdit(editBody.value))) return;
    editingTodoId.value = undefined;
  }

  function cancelEdit() {
    editingTodoId.value = undefined;
  }

  // --- 新規 Todo 作成 ---

  const isAddingTodo = ref(false);
  const newTodoBody = ref("");
  const newTodoIcon = ref<string>();

  function startAddingTodo() {
    isAddingTodo.value = true;
    newTodoBody.value = "";
    newTodoIcon.value = undefined;
  }

  async function saveNewTodo() {
    if (!newTodoBody.value.trim()) {
      isAddingTodo.value = false;
      return;
    }
    const result = await tryCatch(
      request.todoAdd({ body: newTodoBody.value, icon: newTodoIcon.value }),
    );
    if (!result.ok) return;
    isAddingTodo.value = false;
    await fetchData();
  }

  function cancelNewTodo() {
    isAddingTodo.value = false;
  }

  return {
    // 編集
    editingTodoId,
    editBody,
    editIcon,
    startEditing,
    submitEdit,
    cancelEdit,
    saveEditIcon,
    // 新規作成
    isAddingTodo,
    newTodoBody,
    newTodoIcon,
    startAddingTodo,
    saveNewTodo,
    cancelNewTodo,
  };
}
