<doc lang="md">
左端のサイドバー。window 内に同居する全 repo をセクションごとに並べる。

## レイアウト構成

- **トップツールバー**: 左に view mode トグル（active worktree / claude terminals）、右にリスト編集ボタン
- **dirOrder の各 repo** に対して `RepoSection` を縦に並べる
- 各セクションは header（chevron + folder アイコン + repo 名）+ ROOT + WORKTREES
- 編集モード中: 全 section が collapsed + drag で並び替え + ✕ で削除 + 末尾に `+ Add directory`

## 操作

- view mode トグル: active worktree / claude terminals を切り替え。`cmd+/` でも同じ操作が可能
- worktree クリック: 表示対象 dir 切替 + done バッジ既読化
- ⋮ メニュー: SidebarMenu に委譲（worktree 編集 / 解除）
- chevron: 折りたたみトグル（永続）
- 編集モード中の drag handle (folder + 名前): @dnd-kit/vue で並び替え
- 編集モード中の ✕: 確認ダイアログを経て removeRepo
- 編集モード中の `+ Add directory`: NSOpenPanel で dir 追加
- Task 編集は worktree 行の下にインライン展開

## 責務分離

- `useSidebarData` — fetch（per-repo）と terminal title 同期
- `useWorktreeActions` — worktree CRUD（rootDir 引数で対象 repo を特定）
- `useTaskActions` — Task 編集 / 新規作成（rootDir 引数で対象 repo を特定）
- `useDialogs` — 確認ダイアログ
- `RepoSection` — 1 repo の UI
</doc>

<script setup lang="ts">
import type { DragEndEvent } from "@dnd-kit/abstract";
import { move } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/vue";
import { tryCatch } from "@gozd/shared";
import { useIntervalFn } from "@vueuse/core";
import { computed, ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcPickAndOpen } from "../layout";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { RepoSection } from "./features/repo";
import { TaskEditor, useTaskActions } from "./features/task";
import { useWorktreeActions } from "./features/worktree";
import ProjectConfigPanel from "./ProjectConfigPanel.vue";
import SidebarMenu from "./SidebarMenu.vue";
import { useDialogs } from "./useDialogs";
import { useSidebarData } from "./useSidebarData";
import VoicevoxPanel from "./VoicevoxPanel.vue";

const repoStore = useRepoStore();
const worktreeStore = useWorktreeStore();
const terminalStore = useTerminalStore();
const notify = useNotificationStore();

const { fetchRepo } = useSidebarData();

const { confirmRef, confirmMessage, showConfirm, closeConfirm, executeConfirm } = useDialogs();

const { isCreating, handleWorktreeSelect, addWorktree, handleWorktreeRemove } = useWorktreeActions({
  showConfirm,
});

const {
  editingTaskId,
  editBody,
  submitEdit,
  cancelEdit,
  addingTaskForDir,
  addingTaskBody,
  toggleWorktreeTaskEdit,
  saveWorktreeTask,
  cancelWorktreeTaskAdd,
} = useTaskActions({ fetchRepo });

// --- 経過時間表示用の現在時刻 ---

const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
}, 1000);

// --- メニュー ---

const sidebarMenuRef = ref<InstanceType<typeof SidebarMenu>>();

function onWorktreeSelect(wt: import("@gozd/proto").WorktreeEntry) {
  // 同 wt 再クリック時の done 消化は worktreeStore.setOpen の selectionVersion 経由で
  // useSidebarData の watch が処理する。ここでは isActive 分岐せず常に setOpen を呼ぶ。
  handleWorktreeSelect(wt);
}

function onRemoveRepo(rootDir: string) {
  const name = repoStore.repos[rootDir]?.repoName ?? rootDir;
  showConfirm(`Remove "${name}" from this window?`, async () => {
    // repo 削除前に配下 worktree の terminal state / PTY を cleanup する。
    // これを忘れると `claude` view で消したはずの repo の PTY が
    // 生き残る（visitedDirs に残るため）。
    const repo = repoStore.repos[rootDir];
    if (repo !== undefined) {
      const targets = new Set<string>([rootDir, ...repo.worktrees.map((wt) => wt.path)]);
      for (const dir of targets) terminalStore.remove(dir);
    }
    const prevSelected = worktreeStore.dir;
    repoStore.removeRepo(rootDir);
    // 削除した repo に active wt が属していた場合、removeRepo は dirOrder の先頭に
    // selectedDir を直接フォールバックする（setOpen を経由しない）。selectionVersion
    // を進めて新 active wt の done を useSidebarData に消化させるため、ここで明示的に
    // setOpen を再呼びする。selectedDir が変わっていない（別 repo を削除した）場合は no-op。
    const nextSelected = worktreeStore.dir;
    if (nextSelected !== undefined && nextSelected !== prevSelected) {
      worktreeStore.setOpen(nextSelected);
    }
  });
}

async function onAddDir() {
  // native の NSOpenPanel を開いてユーザーに dir を選ばせる。
  // 選択後は内部で onOpen → gozdOpen push → repoStore.addRepo に流れる
  const result = await tryCatch(rpcPickAndOpen({}));
  if (!result.ok) {
    notify.error("Failed to open directory picker", result.error);
  }
}

// --- 編集モード（top-right ボタンでトグル） ---
//
// 編集モード中:
// - 全 section が強制 collapse され、drag で並び替え可能
// - 各 section に ✕ ボタンが表示され、クリックで repo を window から解除（確認ダイアログ）
// - リスト末尾に `+ Add directory` ボタンが出現
// 通常モード:
// - 各 section の永続 collapse 状態が反映される
// - drag は無効、✕ は非表示、+ は非表示

const editMode = ref(false);

function toggleEditMode() {
  editMode.value = !editMode.value;
}

// move() は dragend イベントの operation を見て新しい配列を返す
function onDragEnd(event: DragEndEvent) {
  repoStore.dirOrder = move(repoStore.dirOrder, event);
}

// --- ProjectConfigPanel: active な root worktree がある時だけ表示 ---

const activeRootWorktree = computed(() => {
  const repo = repoStore.selectedRepo;
  if (repo === undefined) return undefined;
  const root = repo.worktrees.find((wt) => wt.isMain);
  if (root === undefined) return undefined;
  return root.path === worktreeStore.dir ? root : undefined;
});
</script>

<template>
  <div class="flex size-full flex-col">
    <!-- トップツールバー: view mode トグル + 編集モード -->
    <div class="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
      <div class="flex gap-0.5">
        <button
          type="button"
          aria-label="Active worktree"
          title="Active worktree"
          :aria-pressed="terminalStore.viewMode === 'wt'"
          class="grid size-7 place-items-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          :class="terminalStore.viewMode === 'wt' && 'bg-zinc-700 text-zinc-100'"
          @click="terminalStore.viewMode = 'wt'"
        >
          <span class="icon-[lucide--monitor] text-base" />
        </button>
        <button
          type="button"
          aria-label="Claude terminals"
          title="Claude terminals"
          :aria-pressed="terminalStore.viewMode === 'claude'"
          :disabled="terminalStore.claudeActiveLeafIds.length === 0"
          class="grid size-7 place-items-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
          :class="terminalStore.viewMode === 'claude' && 'bg-zinc-700 text-zinc-100'"
          @click="terminalStore.viewMode = 'claude'"
        >
          <span class="icon-[lucide--bot] text-base" />
        </button>
      </div>
      <button
        type="button"
        :aria-label="editMode ? 'Exit edit mode' : 'Edit repositories'"
        :title="editMode ? 'Done' : 'Edit repositories'"
        class="grid size-7 place-items-center rounded-sm transition-colors"
        :class="
          editMode
            ? 'bg-blue-600 text-white hover:bg-blue-500'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
        "
        @click="toggleEditMode"
      >
        <span
          class="text-base"
          :class="editMode ? 'icon-[lucide--check]' : 'icon-[lucide--pencil]'"
        />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-3 py-4">
      <DragDropProvider @drag-end="onDragEnd">
        <RepoSection
          v-for="(rootDir, i) in repoStore.dirOrder"
          :key="rootDir"
          :root-dir="rootDir"
          :index="i"
          :edit-mode="editMode"
          :active-dir="worktreeStore.dir"
          :is-creating="isCreating"
          :now="now"
          :get-claude-statuses="terminalStore.getClaudeStatusesByDir"
          :get-resumeable-session-count="terminalStore.getResumeableSessionCount"
          @remove-repo="onRemoveRepo"
          @select-root="handleWorktreeSelect"
          @select-worktree="onWorktreeSelect"
          @add-worktree="addWorktree"
          @open-worktree-menu="
            (anchorEl, wt, rd) =>
              sidebarMenuRef?.openMenu(anchorEl, { type: 'worktree', worktree: wt, rootDir: rd })
          "
        >
          <template #after-worktree-item="{ wt }">
            <TaskEditor
              v-if="wt.tasks[0] && editingTaskId === wt.tasks[0].id"
              v-model:body="editBody"
              @save="submitEdit"
              @cancel="cancelEdit"
            />
            <TaskEditor
              v-if="!wt.tasks[0] && addingTaskForDir === wt.path"
              v-model:body="addingTaskBody"
              @save="saveWorktreeTask(wt)"
              @cancel="cancelWorktreeTaskAdd"
            />
          </template>
        </RepoSection>
      </DragDropProvider>

      <button
        v-if="editMode"
        type="button"
        class="mt-2 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="Add directory"
        @click="onAddDir"
      >
        <span class="icon-[lucide--plus] size-4 shrink-0" />
        <span>Add directory</span>
      </button>
    </div>

    <!-- ⋮ メニュー（worktree） -->
    <SidebarMenu
      ref="sidebarMenuRef"
      @worktree-edit-task="toggleWorktreeTaskEdit"
      @worktree-remove="(wt, rd) => handleWorktreeRemove(rd, wt)"
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
          OK
        </button>
      </div>
    </dialog>

    <!-- Project Config（active な root worktree のみ） -->
    <ProjectConfigPanel v-if="activeRootWorktree" />

    <!-- VOICEVOX -->
    <VoicevoxPanel @error="notify.error" />
  </div>
</template>
