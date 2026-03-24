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

  // --- worktree の Todo 編集・新規作成（入力欄を開き、保存時に永続化） ---

  /** Todo 新規作成中の worktree ディレクトリパス */
  const addingTodoForDir = ref<string>();
  const addingTodoBody = ref("");

  /** worktree の Todo 編集をトグルする。Todo がなければ新規作成入力欄を開く */
  function toggleWorktreeTodoEdit(wt: WorktreeEntry) {
    // 既存 Todo がある場合: 編集トグル
    if (wt.todo) {
      if (editingTodoId.value === wt.todo.id) {
        cancelEdit();
      } else {
        startEditing(wt.todo);
      }
      return;
    }
    // Todo がない場合: 新規作成入力欄のトグル
    if (addingTodoForDir.value === wt.path) {
      cancelWorktreeTodoAdd();
    } else {
      addingTodoForDir.value = wt.path;
      addingTodoBody.value = "";
    }
  }

  const isSavingWorktreeTodo = ref(false);

  /** worktree の Todo 新規作成を保存する */
  async function saveWorktreeTodo(wt: WorktreeEntry) {
    if (isSavingWorktreeTodo.value) return;
    if (!addingTodoBody.value.trim()) {
      cancelWorktreeTodoAdd();
      return;
    }
    isSavingWorktreeTodo.value = true;
    const result = await tryCatch(
      request.todoAdd({ body: addingTodoBody.value, worktreeDir: wt.path }),
    );
    isSavingWorktreeTodo.value = false;
    if (!result.ok) return;
    addingTodoForDir.value = undefined;
    await fetchData();
  }

  function cancelWorktreeTodoAdd() {
    addingTodoForDir.value = undefined;
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
    // worktree Todo 編集・新規作成
    addingTodoForDir,
    addingTodoBody,
    toggleWorktreeTodoEdit,
    saveWorktreeTodo,
    cancelWorktreeTodoAdd,
  };
}
