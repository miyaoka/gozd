<doc lang="md">
左端のサイドバー。プロジェクトの worktree 一覧、Todo、ブランチ一覧を表示する。

## セクション構成

- ROOT: リポジトリルート（main）。メニューなし
- WORKTREES: Todo 紐づき済みの worktree。Todo タイトルまたはブランチ名で表示。Claude 状態バッジ付き
- TODOS: 未着手の Todo（worktreeDir なし）
- BRANCHES: worktree 化されていないローカルブランチ

## 操作

- worktree クリック: 表示対象ディレクトリを切り替え + done バッジをクリア（既読消化）
- `⋮` メニュー: popover + CSS Anchor Positioning で表示
- Todo 編集: サイドバー内にインライン展開

## Claude 状態バッジ

worktree 行ごとの Claude 状態表示は `WorktreeItem.vue` に委譲。
バッジ（アイコン）とメッセージ吹き出し（done/asking 時の一行目テキスト）を表示する。
</doc>

<script setup lang="ts">
import type { Todo, WorktreeEntry } from "@orkis/rpc";
import { tryCatch } from "@orkis/shared";
import { useEventListener, useIntervalFn } from "@vueuse/core";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useCommandRegistry } from "../command/useCommandRegistry";
import { useContextKeys } from "../command/useContextKeys";
import { useDiagnosticsStore } from "../diagnostics/useDiagnosticsStore";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import { useRpc } from "../rpc/useRpc";
import { useTerminalStore } from "../terminal/useTerminalStore";
import { useVoicevoxStore } from "../voicevox/useVoicevoxStore";
import TodoEditor from "./todo/TodoEditor.vue";
import TodoList from "./todo/TodoList.vue";
import { dirName, worktreeDisplayName } from "./utils";
import BranchList from "./worktree/BranchList.vue";
import RootWorktree from "./worktree/RootWorktree.vue";
import WorktreeList from "./worktree/WorktreeList.vue";

const workspaceStore = useWorkspaceStore();
const diagnosticsStore = useDiagnosticsStore();
const terminalStore = useTerminalStore();
const voicevoxStore = useVoicevoxStore();
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

/** main 以外の worktree をディレクトリ名のアルファベット順で */
const nonMainWorktrees = computed(() =>
  worktrees.value
    .filter((wt) => !wt.isMain)
    .sort((a, b) => dirName(a.path).localeCompare(dirName(b.path))),
);

const sortedBranches = computed(() => [...freeBranches.value].sort((a, b) => a.localeCompare(b)));

/** Ctrl+数字で選択可能な worktree（nonMainWorktrees と同一、1-indexed） */
const selectableWorktrees = nonMainWorktrees;

/** Ctrl キー押下中か（番号バッジの表示制御用） */
const ctrlPressed = ref(false);

const contextKeys = useContextKeys();

/**
 * keybinding が editable 要素を除外する条件と一致させる。
 * terminalFocus 時は xterm 内部の textarea を除外しない
 * （keybinding 側も同じ条件でスキップするため）
 */
function shouldSuppressBadge(): boolean {
  if (contextKeys.get("terminalFocus")) return false;
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || target.isContentEditable;
}

useEventListener(document, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Control" && !shouldSuppressBadge()) ctrlPressed.value = true;
});
useEventListener(document, "keyup", (e: KeyboardEvent) => {
  if (e.key === "Control") ctrlPressed.value = false;
});
// ウィンドウからフォーカスが外れた場合にリセット
useEventListener(window, "blur", () => {
  ctrlPressed.value = false;
});
// Ctrl 押下中に editable 要素にフォーカスが移った場合にリセット
useEventListener(document, "focusin", () => {
  if (ctrlPressed.value && shouldSuppressBadge()) ctrlPressed.value = false;
});

// workspace.selectWorktree コマンド: args=1~9 のインデックスで worktree を選択
const { register } = useCommandRegistry();
const disposeSelectWorktree = register("workspace.selectWorktree", (args) => {
  if (typeof args !== "number") return false;
  const wt = selectableWorktrees.value[args - 1];
  if (!wt) return false;
  handleWorktreeSelect(wt);
  return true;
});
onUnmounted(disposeSelectWorktree);

/** 経過時間表示用の現在時刻（1 秒ごとに更新） */
const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
}, 1000);

/** 現在表示中の worktree かどうか */
function isActive(wt: WorktreeEntry): boolean {
  return workspaceStore.dir === wt.path;
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

// --- Todo インライン編集 ---

const editingTodoId = ref<string>();
const editBody = ref("");
const editIcon = ref<string>();
/** 保存済みの body（アイコンのみ保存時に使用） */
const savedBody = ref("");

function startEditing(todo: Todo) {
  closeMenu();
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
  saveEdit(savedBody.value);
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

  // 外部で削除された worktree のターミナルをクリーンアップ
  const wtPaths = new Set(wtList.map((wt) => wt.path));
  const staleDirs = terminalStore.visitedDirs.filter((dir) => !wtPaths.has(dir));
  for (const dir of staleDirs) {
    terminalStore.remove(dir);
  }
}

// --- worktree 操作 ---

/** worktree をクリックして表示対象を切り替える */
async function handleWorktreeSelect(wt: WorktreeEntry) {
  if (isActive(wt)) {
    terminalStore.clearDoneStates(wt.path);
    return;
  }
  if (isSwitching.value) return;
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
    `Failed to remove "${worktreeDisplayName(wt)}" (may have uncommitted changes). Force remove?`,
    async () => {
      const forceResult = await tryCatch(request.gitWorktreeRemove({ path: wt.path, force: true }));
      if (forceResult.ok) {
        removeFromList(wt);
      } else {
        showAlert(`Failed to force remove "${worktreeDisplayName(wt)}".`);
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

watch(
  () => workspaceStore.dir,
  (dir) => {
    fetchData();
    // active dir に切り替わったら done バッジをクリア（既読消化）
    if (dir) {
      terminalStore.clearDoneStates(dir);
    }
  },
  { immediate: true },
);

// --- VOICEVOX ---

async function handleVoicevoxActivate() {
  const errorMessage = await voicevoxStore.activate();
  if (errorMessage) {
    showAlert(errorMessage);
  }
}

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
  <div class="flex size-full flex-col">
    <div class="flex-1 overflow-y-auto p-4">
      <h1 class="mb-4 flex items-center text-lg font-bold" :title="workspaceStore.repoName">
        <span class="mr-2 icon-[lucide--bot] shrink-0 align-middle text-blue-400" />
        <input
          aria-label="Project name"
          class="min-w-0 flex-1 truncate bg-transparent outline-none"
          :value="workspaceStore.repoName ?? 'orkis'"
          @input="workspaceStore.repoName = ($event.target as HTMLInputElement).value"
        />
      </h1>

      <!-- ROOT -->
      <RootWorktree
        :worktree="rootWorktree"
        :active="rootWorktree ? isActive(rootWorktree) : false"
        @select="handleWorktreeSelect"
      />

      <!-- WORKTREES -->
      <WorktreeList
        :worktrees="nonMainWorktrees"
        :loading="worktrees.length === 0"
        :active-dir="workspaceStore.dir"
        :is-creating="isCreating"
        :ctrl-pressed="ctrlPressed"
        :now="now"
        :show-all="terminalStore.showAll"
        :get-claude-statuses="terminalStore.getClaudeStatusesByDir"
        @select="handleWorktreeSelect"
        @open-menu="
          (anchorName, wt) =>
            openMenu(anchorName, { type: 'worktree', worktree: wt, todo: wt.todo })
        "
        @add="addWorktree()"
        @toggle-show-all="terminalStore.showAll = !terminalStore.showAll"
      >
        <template #after-item="{ wt }">
          <TodoEditor
            v-if="wt.todo && editingTodoId === wt.todo.id"
            v-model:body="editBody"
            v-model:icon="editIcon"
            @save="submitEdit"
            @cancel="cancelEdit"
            @icon-change="saveEditIcon"
          />
        </template>
      </WorktreeList>

      <!-- TODOS -->
      <TodoList
        :todos="pendingTodos"
        :editing-todo-id="editingTodoId"
        :is-adding-todo="isAddingTodo"
        @toggle-edit="handleToggleEdit"
        @open-menu="(anchorName, todo) => openMenu(anchorName, { type: 'todo', todo })"
        @start-add="startAddingTodo"
      >
        <template #after-item="{ todo }">
          <TodoEditor
            v-if="editingTodoId === todo.id"
            v-model:body="editBody"
            v-model:icon="editIcon"
            @save="submitEdit"
            @cancel="cancelEdit"
            @icon-change="saveEditIcon"
          />
        </template>
        <template #add-form>
          <TodoEditor
            v-if="isAddingTodo"
            v-model:body="newTodoBody"
            v-model:icon="newTodoIcon"
            placeholder="First line becomes the title"
            @save="saveNewTodo"
            @cancel="cancelNewTodo"
          />
        </template>
      </TodoList>

      <!-- BRANCHES -->
      <BranchList
        :branches="sortedBranches"
        @open-menu="(anchorName, branch) => openMenu(anchorName, { type: 'branch', branch })"
      />
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
          Edit todo
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
          @click="handleWorktreeRemove(menuContext.worktree)"
        >
          <span class="icon-[lucide--unlink] text-xs" />
          Remove worktree
        </button>
      </template>
      <template v-else-if="menuContext?.type === 'todo' && menuContext.todo">
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
          :disabled="isCreating"
          @click="handleTodoStart(menuContext.todo)"
        >
          <span class="icon-[lucide--play] text-xs" />
          Create worktree
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
          @click="handleTodoRemove(menuContext.todo)"
        >
          <span class="icon-[lucide--trash-2] text-xs" />
          Delete todo
        </button>
      </template>
      <template v-else-if="menuContext?.type === 'branch' && menuContext.branch">
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
          :disabled="isCreating"
          @click="handleBranchLink(menuContext.branch)"
        >
          <span class="icon-[lucide--link] text-xs" />
          Create worktree
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
          Cancel
        </button>
        <button
          class="rounded-sm bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
          @click="executeConfirm"
        >
          Remove
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
          Close
        </button>
      </div>
    </dialog>

    <!-- VOICEVOX -->
    <div class="border-t border-zinc-700/50 px-4 py-3">
      <template v-if="voicevoxStore.enabled">
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <span class="icon-[lucide--gauge] size-4 shrink-0" title="Speed" />
            <input
              type="range"
              aria-label="VOICEVOX speed"
              class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-blue-500"
              :min="0.5"
              :max="3.0"
              :step="0.1"
              :value="voicevoxStore.speedScale"
              @input="voicevoxStore.speedScale = Number(($event.target as HTMLInputElement).value)"
            />
            <span class="w-8 text-right tabular-nums">{{
              voicevoxStore.speedScale.toFixed(1)
            }}</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-zinc-500">
            <span class="icon-[lucide--volume-2] size-4 shrink-0" title="Volume" />
            <input
              type="range"
              aria-label="VOICEVOX volume"
              class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-blue-500"
              :min="0.0"
              :max="2.0"
              :step="0.1"
              :value="voicevoxStore.volumeScale"
              @input="voicevoxStore.volumeScale = Number(($event.target as HTMLInputElement).value)"
            />
            <span class="w-8 text-right tabular-nums">{{
              voicevoxStore.volumeScale.toFixed(1)
            }}</span>
          </div>
          <button
            class="mt-1 text-xs text-yellow-500 hover:text-yellow-400"
            @click="voicevoxStore.deactivate()"
          >
            VOICEVOX enabled
          </button>
        </div>
      </template>
      <template v-else>
        <button
          class="flex w-full items-center justify-center gap-2 text-xs text-zinc-500 hover:text-zinc-300"
          :disabled="voicevoxStore.activating"
          @click="handleVoicevoxActivate"
        >
          <span
            class="size-4 shrink-0"
            :class="
              voicevoxStore.activating
                ? 'icon-[lucide--loader] animate-spin'
                : 'icon-[lucide--volume-x]'
            "
          />
          <span>{{ voicevoxStore.activating ? "Starting VOICEVOX..." : "Enable VOICEVOX" }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
