<doc lang="md">
左端のサイドバー。window 内に同居する全 repo をセクションごとに並べる。

## レイアウト構成

- **トップツールバー**: 左に view mode トグル (active worktree / claude terminals)、右にリスト編集ボタン
- **dirOrder の各 repo** に対して `RepoSection` を縦に並べる
- 各 RepoSection は header (folder + repo 名) + WtCard 列 (main wt 先頭固定) + `+ New worktree`
- 編集モード中: 全 section が collapsed + drag で並び替え + ✕ で削除 + 末尾に `+ Add directory`

## クリック挙動

- WtCard ヘッダクリック: `worktreeStore.dir` をその wt に切り替え。focus は wt の `focusedLeafId` 維持
- TaskRow クリック: wt を active にしたうえで、task に対応する PTY の leaf を `focusPane`
- focus 解決: `layoutsByDir[dir].focusedLeafId` (生きていれば) → 無効なら `findFirstLeaf(root)` (ensureLayout が担保)
- ⋮ メニュー: SidebarMenu に委譲 (worktree 行は Remove worktree、task 行は Remove task)

## 責務分離

- `useSidebarData` — fetch (per-repo) と terminal title → task body 同期
- `useWorktreeActions` — worktree CRUD (rootDir 引数で対象 repo を特定)
- `useDialogs` — 確認ダイアログ
- `RepoSection` — 1 repo の UI
- `WtCard` / `TaskRow` — 1 wt と内側の task 行
</doc>

<script setup lang="ts">
import type { DragEndEvent } from "@dnd-kit/abstract";
import { move } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/vue";
import type { Task, WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcPickAndOpen } from "../layout";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { RepoSection } from "./features/repo";
import { useWorktreeActions } from "./features/worktree";
import ProjectConfigPanel from "./ProjectConfigPanel.vue";
import { rpcTaskRemove } from "./rpc";
import SidebarClock from "./SidebarClock.vue";
import SidebarMenu from "./SidebarMenu.vue";
import { useDialogs } from "./useDialogs";
import { useSidebarData } from "./useSidebarData";
import VoicevoxPanel from "./VoicevoxPanel.vue";

const repoStore = useRepoStore();
const worktreeStore = useWorktreeStore();
const terminalStore = useTerminalStore();
const notify = useNotificationStore();

// useSidebarData の onMounted で全 repo の fetch / FsWatch / title sync が起動する。
// 戻り値は現状外側で使わないので呼び捨てる。
useSidebarData();

const { confirmRef, confirmMessage, showConfirm, closeConfirm, executeConfirm } = useDialogs();

const { isCreatingFor, handleWorktreeSelect, addWorktree, handleWorktreeRemove } =
  useWorktreeActions({
    showConfirm,
  });

// --- メニュー ---
//
// SidebarMenu に anchorEl + context を渡して開閉させる。menuOpenState を undefined にする
// 経路は SidebarMenu からの `close` emit に一本化する（light-dismiss / アクション click 両対応）。

type MenuContext =
  | { type: "worktree"; worktree: WorktreeEntry; rootDir: string }
  | { type: "task"; task: Task; rootDir: string };

const menuOpenState = ref<{ anchorEl: HTMLElement; context: MenuContext }>();

function openWorktreeMenu(anchorEl: HTMLElement, wt: WorktreeEntry, rootDir: string) {
  menuOpenState.value = { anchorEl, context: { type: "worktree", worktree: wt, rootDir } };
}

function openTaskMenu(anchorEl: HTMLElement, task: Task, rootDir: string) {
  menuOpenState.value = { anchorEl, context: { type: "task", task, rootDir } };
}

function onCloseMenu() {
  menuOpenState.value = undefined;
}

function onSelectWt(wt: WorktreeEntry) {
  // 同 wt 再クリック時の done 消化は worktreeStore.setOpen の selectionVersion 経由で
  // useSidebarData の watch が処理する。ここでは isActive 分岐せず常に setOpen を呼ぶ。
  handleWorktreeSelect(wt);
}

function onSelectTask(wt: WorktreeEntry, task: Task) {
  // wt を active にしたうえで、task に対応する leaf へフォーカスする。
  // 分岐:
  //  - task.sessionId 空 (PR/issue 由来で未起動 / SessionEnd で切り離し済み):
  //    新規に素の claude を起動する。SessionStart hook が attachSession で
  //    sessionId をこの task に結びつける (sessionId 空の最新 task を選択するため、
  //    同 wt に複数の未紐付け task があると最新が選ばれる仕様)。
  //  - live PTY あり: 該当 leaf を focus
  //  - resumable (sessionId あり、live PTY 無し): `claude --resume` を仕込んで起動
  if (task.sessionId === "") {
    terminalStore.requestNewClaudeSession(wt.path);
    handleWorktreeSelect(wt);
    return;
  }
  const ptyId = terminalStore.getPtyIdBySessionId(task.sessionId);
  if (ptyId === undefined) {
    terminalStore.requestResumeSession(wt.path, task.sessionId);
    handleWorktreeSelect(wt);
    return;
  }
  handleWorktreeSelect(wt);
  const leafId = terminalStore.getLeafIdByPtyId(ptyId);
  if (leafId === undefined) return;
  terminalStore.focusPane(leafId);
}

/** 指定 wt 内で focus が当たっている PTY の ptyId。task ↔ ヘッダの capsule 二者択一に使う */
function getFocusedPtyId(dir: string): number | undefined {
  const focusedLeafId = terminalStore.layoutsByDir[dir]?.focusedLeafId;
  if (focusedLeafId === undefined) return undefined;
  return terminalStore.getPtyId(focusedLeafId);
}

async function handleTaskRemove(rootDir: string, task: Task) {
  // ⋮ メニューからの明示削除。Swift 側 TaskStore.remove で永続化を消した後、
  // `requestRefresh` で server から真値を取り直す。他の task 系操作
  // (reviveTaskForGhRef / registerPrCommand / registerIssueCommand) と SSOT 取得規約を
  // 揃え、`repos[...]` の直書き楽観更新 (race の源) を避ける。
  const result = await tryCatch(rpcTaskRemove({ dir: task.worktreeDir, id: task.id }));
  if (!result.ok) {
    notify.error("Failed to remove task", result.error);
    return;
  }
  repoStore.requestRefresh(rootDir);
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
      <div class="flex items-center gap-2">
        <SidebarClock />
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
    </div>

    <div class="_sidebar-scroll flex flex-1 scrollbar-none flex-col overflow-y-auto py-4">
      <DragDropProvider @drag-end="onDragEnd">
        <RepoSection
          v-for="(rootDir, i) in repoStore.dirOrder"
          :key="rootDir"
          :root-dir="rootDir"
          :index="i"
          :edit-mode="editMode"
          :active-dir="worktreeStore.dir"
          :is-creating="isCreatingFor(rootDir)"
          :get-focused-pty-id="getFocusedPtyId"
          @remove-repo="onRemoveRepo"
          @select-wt="onSelectWt"
          @select-task="onSelectTask"
          @add-worktree="addWorktree"
          @open-worktree-menu="openWorktreeMenu"
          @open-task-menu="openTaskMenu"
        />
      </DragDropProvider>

      <button
        v-if="editMode"
        type="button"
        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="Add directory"
        @click="onAddDir"
      >
        <span class="icon-[lucide--plus] size-4 shrink-0" />
        <span>Add directory</span>
      </button>
    </div>

    <!-- ⋮ メニュー（worktree / task） -->
    <SidebarMenu
      :open-state="menuOpenState"
      @close="onCloseMenu"
      @worktree-remove="(wt, rd) => handleWorktreeRemove(rd, wt)"
      @task-remove="(task, rd) => handleTaskRemove(rd, task)"
    />

    <!-- 確認ダイアログ -->
    <dialog
      ref="confirmRef"
      class="backdrop:bg-black/50"
      @click="$event.target === confirmRef && closeConfirm()"
    >
      <div class="space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-white">
        <p class="text-sm">{{ confirmMessage }}</p>
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
      </div>
    </dialog>

    <!-- Project Config（active な root worktree のみ） -->
    <ProjectConfigPanel v-if="activeRootWorktree" />

    <!-- VOICEVOX -->
    <VoicevoxPanel @error="notify.error" />
  </div>
</template>

<style scoped>
/* scrollbar 自体を非表示 (macOS の overlay も hover で content に被るため使わない)。スクロール操作はトラックパッド / ホイールのみ */
._sidebar-scroll::-webkit-scrollbar {
  display: none;
}
</style>
