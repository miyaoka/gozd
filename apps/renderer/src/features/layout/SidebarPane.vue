<doc lang="md">
左端のサイドバー。プロジェクトの worktree 一覧、Todo、ブランチ一覧を表示する。

## セクション構成

- ROOT: リポジトリルート（main）。メニューなし
- WORKTREES: Todo 紐づき済みの worktree。Todo タイトルまたはブランチ名で表示
- TODOS: 未着手の Todo（worktreeDir なし）
- BRANCHES: worktree 化されていないローカルブランチ

## 操作

- worktree クリック: 表示対象ディレクトリを切り替え
- `⋮` メニュー: popover + CSS Anchor Positioning で表示
- Todo 編集: サイドバー内にインライン展開
</doc>

<script setup lang="ts">
import type { Todo, WorktreeChangeCounts, WorktreeEntry } from "@orkis/rpc";
import { tryCatch } from "@orkis/shared";
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useDiagnosticsStore } from "../diagnostics/useDiagnosticsStore";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import { useRpc } from "../rpc/useRpc";
import { useTerminalStore } from "../terminal/useTerminalStore";
import TodoIconPicker from "./TodoIconPicker.vue";

const workspaceStore = useWorkspaceStore();
const diagnosticsStore = useDiagnosticsStore();
const terminalStore = useTerminalStore();
const { request, onGitStatusChange, onWorktreeChange } = useRpc();

const worktrees = ref<WorktreeEntry[]>([]);
/** worktree 化されていないローカルブランチ */
const freeBranches = ref<string[]>([]);
/** 未着手の Todo（worktreeDir なし） */
const pendingTodos = ref<Todo[]>([]);
const isCreating = ref(false);
const isSwitching = ref(false);
/** fetchData の世代管理（並行実行で stale なレスポンスを破棄するため） */
let fetchGen = 0;

/** root（main）worktree */
const rootWorktree = computed(() => worktrees.value.find((wt) => wt.isMain));

/** パスから末尾のディレクトリ名を取得 */
function dirName(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}

/** main 以外の worktree をディレクトリ名のアルファベット順で */
const nonMainWorktrees = computed(() =>
  worktrees.value
    .filter((wt) => !wt.isMain)
    .sort((a, b) => dirName(a.path).localeCompare(dirName(b.path))),
);

const sortedBranches = computed(() => [...freeBranches.value].sort((a, b) => a.localeCompare(b)));

/** Todo の body 一行目をタイトルとして取得 */
function todoTitle(body: string): string {
  const firstLine = body.split("\n")[0];
  return firstLine ?? "";
}

/** worktree に Todo タイトルが設定されているか */
function hasTodoTitle(wt: WorktreeEntry): boolean {
  return wt.todo?.body ? todoTitle(wt.todo.body) !== "" : false;
}

/** worktree の表示名: Todo タイトルがあればそれ、なければブランチ名 */
function worktreeDisplayName(wt: WorktreeEntry): string {
  if (hasTodoTitle(wt)) return todoTitle(wt.todo!.body);
  return wt.branch ?? "(detached)";
}

/** 現在表示中の worktree かどうか */
function isActive(wt: WorktreeEntry): boolean {
  return workspaceStore.dir === wt.path;
}

/** 変更ファイルがあるかどうか */
function hasChanges(counts: WorktreeChangeCounts | undefined): boolean {
  if (!counts) return false;
  return counts.modified + counts.added + counts.deleted + counts.untracked > 0;
}

// --- ⋮ メニュー ---

interface MenuContext {
  type: "worktree" | "todo" | "branch";
  worktree?: WorktreeEntry;
  todo?: Todo;
  branch?: string;
}

const menuRef = ref<HTMLElement>();
const menuContext = ref<MenuContext>();
/** 現在 anchor になっている ⋮ ボタンの anchor-name */
const activeAnchorName = ref("");

function openMenu(anchorName: string, context: MenuContext) {
  activeAnchorName.value = anchorName;
  menuContext.value = context;
  nextTick(() => {
    menuRef.value?.showPopover();
  });
}

function closeMenu() {
  menuRef.value?.hidePopover();
}

// --- 確認ダイアログ ---

const confirmRef = ref<HTMLDialogElement>();
const confirmMessage = ref("");
const confirmAction = ref<(() => Promise<void>) | undefined>();

function showConfirm(message: string, action: () => Promise<void>) {
  confirmMessage.value = message;
  confirmAction.value = action;
  confirmRef.value?.showModal();
}

function closeConfirm() {
  confirmRef.value?.close();
  confirmAction.value = undefined;
}

async function executeConfirm() {
  const action = confirmAction.value;
  if (!action) return;
  closeConfirm();
  await action();
}

/** 通知ダイアログ */
const alertRef = ref<HTMLDialogElement>();
const alertMessage = ref("");

function showAlert(message: string) {
  alertMessage.value = message;
  alertRef.value?.showModal();
}

/** IME 変換中でない Enter キーのみ発火するガード */
function onEnterSubmit(e: KeyboardEvent, handler: () => void) {
  // WKWebView では isComposing が false のまま keyCode 229 が送られる
  const IME_KEYCODE = 229;
  if (e.isComposing || e.keyCode === IME_KEYCODE || e.shiftKey) return;
  e.preventDefault();
  handler();
}

// --- Todo アイコン ---

// --- Todo インライン編集 ---

const editingTodoId = ref<string>();
const editBody = ref("");
const editIcon = ref<string>();
const editTextareaRefs = useTemplateRef<HTMLTextAreaElement[]>("editTextarea");

function startEditing(todo: Todo) {
  closeMenu();
  editingTodoId.value = todo.id;
  editBody.value = todo.body;
  editIcon.value = todo.icon;
  nextTick(() => {
    const [el] = editTextareaRefs.value ?? [];
    el?.focus();
  });
}

async function saveEdit() {
  const id = editingTodoId.value;
  if (!id) return;
  const result = await tryCatch(
    request.todoUpdate({ id, body: editBody.value, icon: editIcon.value }),
  );
  if (!result.ok) return;
  editingTodoId.value = undefined;
  await fetchData();
}

function cancelEdit() {
  editingTodoId.value = undefined;
}

// --- 新規 Todo 作成 ---

const isAddingTodo = ref(false);
const newTodoBody = ref("");
const newTodoIcon = ref<string>();
const newTodoTextareaRef = ref<HTMLTextAreaElement>();

function startAddingTodo() {
  isAddingTodo.value = true;
  newTodoBody.value = "";
  newTodoIcon.value = undefined;
  nextTick(() => {
    newTodoTextareaRef.value?.focus();
  });
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

// --- データ取得 ---

async function fetchData() {
  if (!workspaceStore.dir) return;
  const gen = ++fetchGen;
  const [wtList, branchList, todoList] = await Promise.all([
    request.gitWorktreeList(),
    request.gitBranchList(),
    request.todoList(),
  ]);
  // 並行実行された新しい fetchData が先に完了していたら、この結果は stale なので破棄
  if (gen !== fetchGen) return;
  worktrees.value = wtList;
  const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
  freeBranches.value = branchList.filter((b) => !wtBranches.has(b));
  pendingTodos.value = todoList.filter((t) => !t.worktreeDir);
}

// --- worktree 操作 ---

/** worktree をクリックして表示対象を切り替える */
async function handleWorktreeSelect(wt: WorktreeEntry) {
  if (isActive(wt) || isSwitching.value) return;
  isSwitching.value = true;
  const result = await tryCatch(request.switchDir({ dir: wt.path }));
  if (result.ok) {
    diagnosticsStore.clear();
    workspaceStore.setOpen(result.value.dir, undefined, result.value.fileServerBaseUrl);
  }
  isSwitching.value = false;
}

async function addWorktree(branch?: string) {
  isCreating.value = true;
  if (branch) {
    freeBranches.value = freeBranches.value.filter((b) => b !== branch);
  }

  const result = await tryCatch(request.gitWorktreeAdd({ branch }));
  if (result.ok) {
    await fetchData();
  } else if (branch) {
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
  // ターミナルの visitedDirs から除去（TerminalPane を破棄させる）
  terminalStore.remove(wt.path);
}

/** worktree 解除: まず通常削除、失敗したら確認後 --force */
async function handleWorktreeRemove(wt: WorktreeEntry) {
  closeMenu();
  const result = await tryCatch(request.gitWorktreeRemove({ path: wt.path }));
  if (result.ok) {
    removeFromList(wt);
    return;
  }
  showConfirm(
    `"${worktreeDisplayName(wt)}" の解除に失敗しました（未コミットの変更がある可能性があります）。強制的に解除しますか？`,
    async () => {
      const forceResult = await tryCatch(request.gitWorktreeRemove({ path: wt.path, force: true }));
      if (forceResult.ok) {
        removeFromList(wt);
      } else {
        showAlert(`"${worktreeDisplayName(wt)}" の強制解除に失敗しました。`);
      }
    },
  );
}

// --- Todo 操作 ---

async function handleTodoStart(todo: Todo) {
  closeMenu();
  isCreating.value = true;
  const result = await tryCatch(request.todoStart({ id: todo.id }));
  if (result.ok) {
    await fetchData();
  }
  isCreating.value = false;
}

async function handleTodoRemove(todo: Todo) {
  closeMenu();
  const result = await tryCatch(request.todoRemove({ id: todo.id }));
  if (!result.ok) return;
  pendingTodos.value = pendingTodos.value.filter((t) => t.id !== todo.id);
}

// --- メニューからの Todo 編集（worktree 紐づき） ---

/** worktree の Todo を編集する。Todo がなければ作成してから編集 */
async function handleWorktreeEditTodo(wt: WorktreeEntry) {
  closeMenu();
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

// --- ブランチの worktree 化 ---

function handleBranchLink(branch: string) {
  closeMenu();
  addWorktree(branch);
}

watch(() => workspaceStore.dir, fetchData, { immediate: true });

const cleanups: Array<() => void> = [];
onMounted(() => {
  cleanups.push(onGitStatusChange(() => fetchData()));
  cleanups.push(onWorktreeChange(() => fetchData()));
});
onUnmounted(() => {
  for (const cleanup of cleanups) cleanup();
});
</script>

<template>
  <div class="flex size-full flex-col p-4">
    <h1 class="mb-4 truncate text-lg font-bold" :title="workspaceStore.repoName">
      <span class="mr-2 icon-[lucide--bot] align-middle text-blue-400" />
      {{ workspaceStore.repoName ?? "orkis" }}
    </h1>

    <!-- ROOT -->
    <div v-if="rootWorktree" class="flex flex-col">
      <h2 class="mb-1 text-xs font-medium text-zinc-500">ROOT</h2>
      <button
        class="grid w-full grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left"
        :class="isActive(rootWorktree) ? 'bg-zinc-700/50' : 'hover:bg-zinc-800'"
        @click="handleWorktreeSelect(rootWorktree)"
      >
        <span class="row-span-2 mt-0.5 icon-[lucide--home] text-base text-zinc-500" />
        <span
          class="truncate text-sm"
          :class="isActive(rootWorktree) ? 'font-medium text-blue-300' : 'text-zinc-400'"
        >
          {{ rootWorktree.branch ?? "(detached)" }}
        </span>
        <span class="flex min-h-5 items-center gap-2 text-xs">
          <span
            v-if="rootWorktree.changeCounts && hasChanges(rootWorktree.changeCounts)"
            class="flex items-center gap-1.5"
          >
            <span v-if="rootWorktree.changeCounts.modified > 0" class="text-yellow-500">
              <span class="mr-0.5 icon-[lucide--pencil] align-middle text-[10px]" />{{
                rootWorktree.changeCounts.modified
              }}
            </span>
            <span v-if="rootWorktree.changeCounts.added > 0" class="text-green-500">
              <span class="mr-0.5 icon-[lucide--plus] align-middle text-[10px]" />{{
                rootWorktree.changeCounts.added
              }}
            </span>
            <span v-if="rootWorktree.changeCounts.deleted > 0" class="text-red-500">
              <span class="mr-0.5 icon-[lucide--minus] align-middle text-[10px]" />{{
                rootWorktree.changeCounts.deleted
              }}
            </span>
            <span v-if="rootWorktree.changeCounts.untracked > 0" class="text-zinc-400">
              <span class="mr-0.5 icon-[lucide--help-circle] align-middle text-[10px]" />{{
                rootWorktree.changeCounts.untracked
              }}
            </span>
          </span>
        </span>
      </button>
    </div>

    <!-- WORKTREES -->
    <div class="mt-4 flex flex-col">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-xs font-medium text-zinc-500">WORKTREES</h2>
        <button
          type="button"
          class="grid size-6 place-items-center rounded-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          :class="terminalStore.showAll && 'bg-zinc-700 text-zinc-200'"
          title="Show all worktree terminals"
          @click="terminalStore.showAll = !terminalStore.showAll"
        >
          <span class="icon-[lucide--layout-grid] text-sm" />
        </button>
      </div>

      <div v-for="(wt, i) in nonMainWorktrees" :key="wt.path">
        <!-- 擬似要素パターン: button の ::after で親全体をクリック可能にし、⋮ は z-index で上に出す -->
        <div
          class="group/wt relative grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2"
          :class="isActive(wt) ? 'bg-zinc-700/50' : 'hover:bg-zinc-800'"
        >
          <span v-if="wt.todo?.icon" class="row-span-2 mt-0.5 text-base">{{ wt.todo.icon }}</span>
          <span
            v-else
            class="row-span-2 mt-0.5 icon-[lucide--git-branch] text-base text-zinc-400"
          />
          <!-- メインアクション: ::after で親全体に広がるクリック領域 -->
          <button
            class="truncate text-left text-sm after:absolute after:inset-0"
            :class="
              isActive(wt)
                ? 'font-medium text-blue-300'
                : hasTodoTitle(wt)
                  ? 'text-zinc-200'
                  : 'text-zinc-500'
            "
            @click="handleWorktreeSelect(wt)"
          >
            {{ worktreeDisplayName(wt) }}
          </button>
          <!-- ⋮ メニューボタン: z-10 で擬似要素の上に出す -->
          <button
            aria-label="Menu"
            class="relative z-10 row-span-2 grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:text-zinc-300"
            :style="{ anchorName: `--wt-menu-${i}` }"
            @click="openMenu(`--wt-menu-${i}`, { type: 'worktree', worktree: wt, todo: wt.todo })"
          >
            <span class="icon-[lucide--ellipsis-vertical] text-sm" />
          </button>
          <span class="flex min-h-5 items-center gap-2 text-xs">
            <span
              v-if="wt.changeCounts && hasChanges(wt.changeCounts)"
              class="flex items-center gap-1.5"
            >
              <span
                v-if="wt.changeCounts.modified > 0"
                class="text-yellow-500"
                :title="`${wt.changeCounts.modified} modified`"
              >
                <span class="mr-0.5 icon-[lucide--pencil] align-middle text-[10px]" />{{
                  wt.changeCounts.modified
                }}
              </span>
              <span
                v-if="wt.changeCounts.added > 0"
                class="text-green-500"
                :title="`${wt.changeCounts.added} added`"
              >
                <span class="mr-0.5 icon-[lucide--plus] align-middle text-[10px]" />{{
                  wt.changeCounts.added
                }}
              </span>
              <span
                v-if="wt.changeCounts.deleted > 0"
                class="text-red-500"
                :title="`${wt.changeCounts.deleted} deleted`"
              >
                <span class="mr-0.5 icon-[lucide--minus] align-middle text-[10px]" />{{
                  wt.changeCounts.deleted
                }}
              </span>
              <span
                v-if="wt.changeCounts.untracked > 0"
                class="text-zinc-400"
                :title="`${wt.changeCounts.untracked} untracked`"
              >
                <span class="mr-0.5 icon-[lucide--help-circle] align-middle text-[10px]" />{{
                  wt.changeCounts.untracked
                }}
              </span>
            </span>
          </span>
        </div>

        <!-- インライン Todo 編集 -->
        <div v-if="wt.todo && editingTodoId === wt.todo.id" class="mx-2 mt-1 mb-2">
          <TodoIconPicker v-model="editIcon" />
          <textarea
            ref="editTextarea"
            v-model="editBody"
            class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
            rows="4"
            @keydown.enter="onEnterSubmit($event, saveEdit)"
            @keydown.escape="cancelEdit"
          />
          <div class="mt-1 flex justify-end gap-1">
            <button
              class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              @click="cancelEdit"
            >
              キャンセル
            </button>
            <button
              class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
              @click="saveEdit"
            >
              保存
            </button>
          </div>
        </div>
      </div>

      <p v-if="worktrees.length === 0" class="py-2 pl-2 text-sm text-zinc-500">読み込み中...</p>

      <button
        class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        :disabled="isCreating"
        @click="addWorktree()"
      >
        <span class="icon-[lucide--plus] text-base" />
        <span>New worktree</span>
      </button>
    </div>

    <!-- TODOS -->
    <div class="mt-4 flex flex-col">
      <h2 class="mb-1 text-xs font-medium text-zinc-500">TODOS</h2>

      <div v-for="(todo, i) in pendingTodos" :key="todo.id">
        <div
          class="group/td relative grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 hover:bg-zinc-800"
        >
          <span class="mt-0.5 text-base text-zinc-600">{{ todo.icon || "☐" }}</span>
          <button
            class="truncate text-left text-sm text-zinc-400 after:absolute after:inset-0"
            @click="editingTodoId === todo.id ? cancelEdit() : startEditing(todo)"
          >
            {{ todoTitle(todo.body) || "(未入力)" }}
          </button>
          <!-- ⋮ メニューボタン -->
          <button
            aria-label="Menu"
            class="relative z-10 grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/td:opacity-100 group-hover/td:opacity-100 hover:text-zinc-300"
            :style="{ anchorName: `--todo-menu-${i}` }"
            @click="openMenu(`--todo-menu-${i}`, { type: 'todo', todo })"
          >
            <span class="icon-[lucide--ellipsis-vertical] text-sm" />
          </button>
        </div>

        <!-- インライン Todo 編集 -->
        <div v-if="editingTodoId === todo.id" class="mx-2 mt-1 mb-2">
          <TodoIconPicker v-model="editIcon" />
          <textarea
            ref="editTextarea"
            v-model="editBody"
            class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
            rows="4"
            @keydown.enter="onEnterSubmit($event, saveEdit)"
            @keydown.escape="cancelEdit"
          />
          <div class="mt-1 flex justify-end gap-1">
            <button
              class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              @click="cancelEdit"
            >
              キャンセル
            </button>
            <button
              class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
              @click="saveEdit"
            >
              保存
            </button>
          </div>
        </div>
      </div>

      <!-- 新規 Todo 追加 -->
      <div v-if="isAddingTodo" class="mx-2 mt-1">
        <TodoIconPicker v-model="newTodoIcon" />
        <textarea
          ref="newTodoTextareaRef"
          v-model="newTodoBody"
          class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          rows="4"
          placeholder="First line becomes the title"
          @keydown.enter="onEnterSubmit($event, saveNewTodo)"
          @keydown.escape="cancelNewTodo"
        />
        <div class="mt-1 flex justify-end gap-1">
          <button
            class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
            @click="cancelNewTodo"
          >
            キャンセル
          </button>
          <button
            class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
            @click="saveNewTodo"
          >
            保存
          </button>
        </div>
      </div>

      <button
        v-if="!isAddingTodo"
        class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        @click="startAddingTodo"
      >
        <span class="icon-[lucide--plus] text-base" />
        <span>New todo</span>
      </button>
    </div>

    <!-- BRANCHES -->
    <div v-if="sortedBranches.length > 0" class="mt-4 flex flex-col">
      <h2 class="mb-1 text-xs font-medium text-zinc-500">BRANCHES</h2>

      <div
        v-for="(branch, i) in sortedBranches"
        :key="branch"
        class="group/br grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 text-sm text-zinc-500 hover:bg-zinc-800"
      >
        <span class="icon-[lucide--git-branch] text-base" />
        <span class="truncate">{{ branch }}</span>
        <button
          aria-label="Menu"
          class="grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/br:opacity-100 group-hover/br:opacity-100 hover:text-zinc-300"
          :style="{ anchorName: `--br-menu-${i}` }"
          @click.stop="openMenu(`--br-menu-${i}`, { type: 'branch', branch })"
        >
          <span class="icon-[lucide--ellipsis-vertical] text-sm" />
        </button>
      </div>
    </div>

    <!-- 共有 ⋮ ポップオーバーメニュー -->
    <div
      ref="menuRef"
      popover="auto"
      class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
      :style="{
        positionAnchor: activeAnchorName,
        top: 'anchor(bottom)',
        left: 'anchor(left)',
      }"
    >
      <template v-if="menuContext?.type === 'worktree' && menuContext.worktree">
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
          @click="handleWorktreeEditTodo(menuContext.worktree)"
        >
          <span class="icon-[lucide--pencil] text-xs" />
          Todo を編集
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
          @click="handleWorktreeRemove(menuContext.worktree)"
        >
          <span class="icon-[lucide--unlink] text-xs" />
          wt を削除
        </button>
      </template>
      <template v-else-if="menuContext?.type === 'todo' && menuContext.todo">
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
          :disabled="isCreating"
          @click="handleTodoStart(menuContext.todo)"
        >
          <span class="icon-[lucide--play] text-xs" />
          Worktree 化
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
          @click="handleTodoRemove(menuContext.todo)"
        >
          <span class="icon-[lucide--trash-2] text-xs" />
          Todo を削除
        </button>
      </template>
      <template v-else-if="menuContext?.type === 'branch' && menuContext.branch">
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
          :disabled="isCreating"
          @click="handleBranchLink(menuContext.branch)"
        >
          <span class="icon-[lucide--link] text-xs" />
          Worktree 化
        </button>
      </template>
    </div>

    <!-- 確認ダイアログ -->
    <dialog
      ref="confirmRef"
      class="fixed inset-0 m-auto size-fit rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-white backdrop:bg-black/50"
      @click="$event.target === confirmRef && closeConfirm()"
    >
      <p class="mb-4 text-sm">{{ confirmMessage }}</p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded-sm px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          @click="closeConfirm"
        >
          キャンセル
        </button>
        <button
          class="rounded-sm bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
          @click="executeConfirm"
        >
          削除
        </button>
      </div>
    </dialog>

    <!-- 通知ダイアログ -->
    <dialog
      ref="alertRef"
      class="fixed inset-0 m-auto size-fit rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-white backdrop:bg-black/50"
      @click="$event.target === alertRef && alertRef?.close()"
    >
      <p class="mb-4 text-sm">{{ alertMessage }}</p>
      <div class="flex justify-end">
        <button
          class="rounded-sm px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          @click="alertRef?.close()"
        >
          閉じる
        </button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
