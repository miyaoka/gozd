<doc lang="md">
左端のサイドバー。プロジェクトの worktree 一覧、Task、ブランチ一覧を表示する。

## セクション構成

- ROOT: リポジトリルート（main）。メニューなし
- WORKTREES: Task 紐づき済みの worktree。Task タイトルまたはブランチ名で表示。Claude 状態バッジ付き
- TASKS: 未着手の Task（worktreeDir なし）
- BRANCHES: worktree 化されていないローカルブランチ

## 操作

- worktree クリック: 表示対象ディレクトリを切り替え + done バッジをクリア（既読消化）
- `⋮` メニュー: SidebarMenu コンポーネントに委譲
- Task 編集: サイドバー内にインライン展開

## Claude 状態バッジ

worktree 行ごとの Claude 状態表示は `WorktreeItem.vue` に委譲。
バッジ（アイコン）とメッセージ吹き出し（done/asking 時の一行目テキスト）を表示する。

## 責務分離

ロジックは composable に切り出し、SidebarPane はレイアウトとサブ機能の組み合わせに専念する。

- `useSidebarData` — データ取得・状態管理（worktrees, freeBranches, pendingTasks）
- `useWorktreeActions` — worktree CRUD・選択・切り替え（独自 isCreating）
- `useTaskActions` — Task CRUD・インライン編集（独立した状態管理）
- `useDialogs` — 確認ダイアログの状態管理
- `useCtrlBadge` — Ctrl キー押下検知
- `SidebarMenu` — ⋮ ポップオーバーメニュー
- `VoicevoxPanel` — VOICEVOX 操作パネル
</doc>

<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { onUnmounted, ref } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { useProjectStore } from "../../shared/project";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore, generateTimestamp } from "../worktree";
import { TaskEditor, TaskList, useTaskActions } from "./features/task";
import { BranchList, RootWorktree, WorktreeList, useWorktreeActions } from "./features/worktree";
import ProjectConfigPanel from "./ProjectConfigPanel.vue";
import SidebarMenu from "./SidebarMenu.vue";
import { useCtrlBadge } from "./useCtrlBadge";
import { useDialogs } from "./useDialogs";
import { useSidebarData } from "./useSidebarData";
import VoicevoxPanel from "./VoicevoxPanel.vue";

const worktreeStore = useWorktreeStore();
const projectStore = useProjectStore();
const terminalStore = useTerminalStore();
const notify = useNotificationStore();

const {
  worktrees,
  freeBranches,
  pendingTasks,
  rootWorktree,
  nonMainWorktrees,
  sortedBranches,
  fetchData,
} = useSidebarData();

const { confirmRef, confirmMessage, showConfirm, closeConfirm, executeConfirm } = useDialogs();

const {
  isCreating,
  isActive,
  handleWorktreeSelect,
  addWorktree,
  handleWorktreeRemove,
  createWorktreeWithTask,
  handleBranchLink,
} = useWorktreeActions({ worktrees, freeBranches, showConfirm });

const {
  editingTaskId,
  editBody,
  submitEdit,
  cancelEdit,
  handleToggleEdit,
  isAddingTask,
  newTaskBody,
  startAddingTask,
  saveNewTask,
  cancelNewTask,
  handleTaskRemove,
  addingTaskForDir,
  addingTaskBody,
  toggleWorktreeTaskEdit,
  saveWorktreeTask,
  cancelWorktreeTaskAdd,
} = useTaskActions({ pendingTasks, fetchData });

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

/** worktree クリック: active なら Task 編集トグル、そうでなければ切り替え */
function onWorktreeSelect(wt: import("@gozd/rpc").WorktreeEntry) {
  terminalStore.viewMode = "wt";
  if (isActive(wt)) {
    terminalStore.clearDoneStates(wt.path);
    void toggleWorktreeTaskEdit(wt);
    return;
  }
  handleWorktreeSelect(wt);
}

function handleMenuTaskCreateWorktree(task: import("@gozd/rpc").Task) {
  const timestamp = generateTimestamp();
  createWorktreeWithTask({ task, worktreeDir: timestamp, branch: timestamp });
}
</script>

<template>
  <div class="flex size-full flex-col">
    <div class="flex-1 overflow-y-auto px-3 py-4">
      <h1 class="mb-4 flex items-center text-lg font-bold" :title="projectStore.repoName">
        <span class="mr-2 icon-[lucide--bot] shrink-0 align-middle text-blue-400" />
        <input
          aria-label="Project name"
          class="min-w-0 flex-1 truncate bg-transparent outline-none"
          :value="projectStore.repoName ?? 'gozd'"
          @input="projectStore.repoName = ($event.target as HTMLInputElement).value"
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
        :ctrl-pressed="ctrlPressed"
        :now="now"
        :view-mode="terminalStore.viewMode"
        :get-claude-statuses="terminalStore.getClaudeStatusesByDir"
        @select="onWorktreeSelect"
        @open-menu="
          (anchorName, wt) =>
            sidebarMenuRef?.openMenu(anchorName, { type: 'worktree', worktree: wt, task: wt.task })
        "
        @add="addWorktree"
        @set-view-mode="terminalStore.viewMode = $event"
      >
        <template #after-item="{ wt }">
          <TaskEditor
            v-if="wt.task && editingTaskId === wt.task.id"
            v-model:body="editBody"
            @save="submitEdit"
            @cancel="cancelEdit"
          />
          <TaskEditor
            v-if="!wt.task && addingTaskForDir === wt.path"
            v-model:body="addingTaskBody"
            @save="saveWorktreeTask(wt)"
            @cancel="cancelWorktreeTaskAdd"
          />
        </template>
      </WorktreeList>

      <!-- TASKS -->
      <TaskList
        :tasks="pendingTasks"
        :editing-task-id="editingTaskId"
        :is-adding-task="isAddingTask"
        @toggle-edit="handleToggleEdit"
        @open-menu="
          (anchorName, task) => sidebarMenuRef?.openMenu(anchorName, { type: 'task', task })
        "
        @start-add="startAddingTask"
      >
        <template #after-item="{ task }">
          <TaskEditor
            v-if="editingTaskId === task.id"
            v-model:body="editBody"
            @save="submitEdit"
            @cancel="cancelEdit"
          />
        </template>
        <template #add-form>
          <TaskEditor
            v-if="isAddingTask"
            v-model:body="newTaskBody"
            placeholder="First line becomes the title"
            @save="saveNewTask"
            @cancel="cancelNewTask"
          />
        </template>
      </TaskList>

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
      @worktree-edit-task="toggleWorktreeTaskEdit"
      @worktree-remove="handleWorktreeRemove"
      @task-create-worktree="handleMenuTaskCreateWorktree"
      @task-remove="handleTaskRemove"
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

    <!-- Project Config（メイン worktree 表示時のみ） -->
    <ProjectConfigPanel v-if="rootWorktree && isActive(rootWorktree)" />

    <!-- VOICEVOX -->
    <VoicevoxPanel @error="notify.error" />
  </div>
</template>
