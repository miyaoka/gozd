<doc lang="md">
左端のサイドバー。プロジェクトの worktree 一覧、Todo、ブランチ一覧を表示する。

## セクション構成

- ROOT: リポジトリルート（main）。メニューなし
- WORKTREES: Todo 紐づき済みの worktree。Todo タイトルまたはブランチ名で表示。Claude 状態バッジ付き
- TODOS: 未着手の Todo（worktreeDir なし）
- BRANCHES: worktree 化されていないローカルブランチ

## 操作

- worktree クリック: 表示対象ディレクトリを切り替え + done バッジをクリア（既読消化）
- `⋮` メニュー: SidebarMenu コンポーネントに委譲
- Todo 編集: サイドバー内にインライン展開

## Claude 状態バッジ

worktree 行ごとの Claude 状態表示は `WorktreeItem.vue` に委譲。
バッジ（アイコン）とメッセージ吹き出し（done/asking 時の一行目テキスト）を表示する。

## 責務分離

ロジックは composable に切り出し、SidebarPane はレイアウトとサブ機能の組み合わせに専念する。

- `useSidebarData` — データ取得・状態管理（worktrees, freeBranches, pendingTodos）
- `useWorktreeActions` — worktree CRUD・選択・切り替え（独自 isCreating）
- `useTodoActions` — Todo CRUD・インライン編集（独立した状態管理）
- `useDialogs` — 確認・通知ダイアログの状態管理
- `useCtrlBadge` — Ctrl キー押下検知
- `SidebarMenu` — ⋮ ポップオーバーメニュー
- `VoicevoxPanel` — VOICEVOX 操作パネル
</doc>

<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { onUnmounted, ref } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { TodoEditor, TodoList, useTodoActions } from "./features/todo";
import { BranchList, RootWorktree, WorktreeList, useWorktreeActions } from "./features/worktree";
import SidebarMenu from "./SidebarMenu.vue";
import { useCtrlBadge } from "./useCtrlBadge";
import { useDialogs } from "./useDialogs";
import { useSidebarData } from "./useSidebarData";
import { generateTimestamp } from "./utils";
import VoicevoxPanel from "./VoicevoxPanel.vue";

const worktreeStore = useWorktreeStore();
const terminalStore = useTerminalStore();

const {
  worktrees,
  freeBranches,
  pendingTodos,
  rootWorktree,
  nonMainWorktrees,
  sortedBranches,
  fetchData,
} = useSidebarData();

const {
  confirmRef,
  confirmMessage,
  showConfirm,
  closeConfirm,
  executeConfirm,
  alertRef,
  alertMessage,
  showAlert,
} = useDialogs();

const {
  isCreating,
  isActive,
  handleWorktreeSelect,
  handleWorktreeRemove,
  createWorktreeWithTodo,
  handleBranchLink,
  isAddingWorktree,
  newWorktreeBody,
  newWorktreeIcon,
  startAddingWorktree,
  submitNewWorktree,
  cancelNewWorktree,
} = useWorktreeActions({ worktrees, freeBranches, fetchData, showConfirm, showAlert });

const {
  editingTodoId,
  editBody,
  editIcon,
  submitEdit,
  cancelEdit,
  saveEditIcon,
  handleToggleEdit,
  isAddingTodo,
  newTodoBody,
  newTodoIcon,
  startAddingTodo,
  saveNewTodo,
  cancelNewTodo,
  handleTodoRemove,
  editWorktreeTodo,
} = useTodoActions({ pendingTodos, fetchData });

const { ctrlPressed } = useCtrlBadge();

// --- コマンドレジストリ: Ctrl+数字で worktree 選択 ---

const { register } = useCommandRegistry();
const disposeSelectWorktree = register("workspace.selectWorktree", (args) => {
  if (typeof args !== "number") return false;
  const wt = nonMainWorktrees.value[args - 1];
  if (!wt) return false;
  handleWorktreeSelect(wt);
  return true;
});
onUnmounted(disposeSelectWorktree);

// --- 経過時間表示用の現在時刻 ---

const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
}, 1000);

// --- メニュー ---

const sidebarMenuRef = ref<InstanceType<typeof SidebarMenu>>();

function handleMenuTodoCreateWorktree(todo: import("@gozd/rpc").Todo) {
  const timestamp = generateTimestamp();
  createWorktreeWithTodo({ todo, worktreeDir: timestamp, branch: timestamp });
}
</script>

<template>
  <div class="flex size-full flex-col">
    <div class="flex-1 overflow-y-auto p-4">
      <h1 class="mb-4 flex items-center text-lg font-bold" :title="worktreeStore.repoName">
        <span class="mr-2 icon-[lucide--bot] shrink-0 align-middle text-blue-400" />
        <input
          aria-label="Project name"
          class="min-w-0 flex-1 truncate bg-transparent outline-none"
          :value="worktreeStore.repoName ?? 'gozd'"
          @input="worktreeStore.repoName = ($event.target as HTMLInputElement).value"
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
        :active-dir="worktreeStore.dir"
        :is-creating="isCreating"
        :is-adding-worktree="isAddingWorktree"
        :ctrl-pressed="ctrlPressed"
        :now="now"
        :view-mode="terminalStore.viewMode"
        :get-claude-statuses="terminalStore.getClaudeStatusesByDir"
        @select="handleWorktreeSelect"
        @open-menu="
          (anchorName, wt) =>
            sidebarMenuRef?.openMenu(anchorName, { type: 'worktree', worktree: wt, todo: wt.todo })
        "
        @add="startAddingWorktree"
        @set-view-mode="terminalStore.viewMode = $event"
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
        <template #add-form>
          <TodoEditor
            v-if="isAddingWorktree"
            v-model:body="newWorktreeBody"
            v-model:icon="newWorktreeIcon"
            @save="submitNewWorktree"
            @cancel="cancelNewWorktree"
          />
        </template>
      </WorktreeList>

      <!-- TODOS -->
      <TodoList
        :todos="pendingTodos"
        :editing-todo-id="editingTodoId"
        :is-adding-todo="isAddingTodo"
        @toggle-edit="handleToggleEdit"
        @open-menu="
          (anchorName, todo) => sidebarMenuRef?.openMenu(anchorName, { type: 'todo', todo })
        "
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
        @open-menu="
          (anchorName, branch) => sidebarMenuRef?.openMenu(anchorName, { type: 'branch', branch })
        "
      />
    </div>

    <!-- ⋮ メニュー -->
    <SidebarMenu
      ref="sidebarMenuRef"
      :is-creating="isCreating"
      @worktree-edit-todo="editWorktreeTodo"
      @worktree-remove="handleWorktreeRemove"
      @todo-create-worktree="handleMenuTodoCreateWorktree"
      @todo-remove="handleTodoRemove"
      @branch-link="handleBranchLink"
    />

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
    <VoicevoxPanel @error="showAlert" />
  </div>
</template>
