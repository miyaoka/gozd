import type { Todo, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import type { Ref } from "vue";
import { ref } from "vue";
import { useRpc } from "../../../../shared/rpc";

interface UseTodoActionsOptions {
  pendingTodos: Ref<Todo[]>;
  fetchData: () => Promise<void>;
}

/**
 * Todo の CRUD とインライン編集。
 * 新規作成・編集・削除の状態を独立管理する。
 */
export function useTodoActions({ pendingTodos, fetchData }: UseTodoActionsOptions) {
  const { request } = useRpc();

  // --- インライン編集 ---

  const editingTodoId = ref<string>();
  const editBody = ref("");
  /** 編集開始時のアイコン（body 保存時に現在の値を維持するために使用） */
  const editIcon = ref<string>();

  function startEditing(todo: Todo) {
    editingTodoId.value = todo.id;
    editBody.value = todo.body;
    editIcon.value = todo.icon;
  }

  async function saveEdit(body: string): Promise<boolean> {
    const id = editingTodoId.value;
    if (!id) return false;
    const result = await tryCatch(request.todoUpdate({ id, body, icon: editIcon.value }));
    if (!result.ok) return false;
    await fetchData();
    return true;
  }

  /** 保存ボタン / Enter: 編集中の body で保存してパネルを閉じる */
  async function submitEdit() {
    if (!(await saveEdit(editBody.value))) return;
    editingTodoId.value = undefined;
  }

  function cancelEdit() {
    editingTodoId.value = undefined;
  }

  /** Todo クリックで編集をトグル */
  function handleToggleEdit(todo: Todo) {
    if (editingTodoId.value === todo.id) {
      cancelEdit();
    } else {
      startEditing(todo);
    }
  }

  // --- 新規 Todo 作成 ---

  const isAddingTodo = ref(false);
  const newTodoBody = ref("");

  function startAddingTodo() {
    isAddingTodo.value = true;
    newTodoBody.value = "";
  }

  async function saveNewTodo() {
    if (!newTodoBody.value.trim()) {
      isAddingTodo.value = false;
      return;
    }
    const result = await tryCatch(request.todoAdd({ body: newTodoBody.value }));
    if (!result.ok) return;
    isAddingTodo.value = false;
    await fetchData();
  }

  function cancelNewTodo() {
    isAddingTodo.value = false;
  }

  // --- アイコン更新（リスト上の直接操作） ---

  async function updateTodoIcon(todo: Todo, icon: string | undefined) {
    const result = await tryCatch(request.todoUpdate({ id: todo.id, body: todo.body, icon }));
    if (!result.ok) return;
    // 編集中の todo のアイコンが変わった場合、saveEdit が古い値で上書きしないよう同期する
    if (editingTodoId.value === todo.id) {
      editIcon.value = icon;
    }
    await fetchData();
  }

  // --- Todo 操作 ---

  async function handleTodoRemove(todo: Todo) {
    const result = await tryCatch(request.todoRemove({ id: todo.id }));
    if (!result.ok) return;
    pendingTodos.value = pendingTodos.value.filter((t) => t.id !== todo.id);
  }

  /** worktree の Todo を編集する。Todo がなければ作成してから編集 */
  async function editWorktreeTodo(wt: WorktreeEntry) {
    if (wt.todo) {
      startEditing(wt.todo);
      return;
    }
    // Todo がまだない worktree: 空 body で作成して紐づけ
    const result = await tryCatch(request.todoAdd({ body: "", worktreeDir: wt.path }));
    if (!result.ok) return;
    wt.todo = result.value;
    startEditing(result.value);
  }

  return {
    // インライン編集
    editingTodoId,
    editBody,
    startEditing,
    submitEdit,
    cancelEdit,
    handleToggleEdit,
    // 新規作成
    isAddingTodo,
    newTodoBody,
    startAddingTodo,
    saveNewTodo,
    cancelNewTodo,
    // アイコン更新
    updateTodoIcon,
    // 操作
    handleTodoRemove,
    editWorktreeTodo,
  };
}
