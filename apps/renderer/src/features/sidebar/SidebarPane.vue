<doc lang="md">
左端のサイドバー。window 内に同居する全 repo をセクションごとに並べる。

## レイアウト構成

- **トップツールバー**: 左に view mode トグル (active worktree / claude terminals)、右にリスト編集ボタン
- **dirOrder の各 repo** に対して `RepoSection` を縦に並べる
- **claude ビュー中のフィルタ**: `terminalStore.claudeActiveDirs` に該当する dir を持つ repo だけ表示
  (worktree / task の絞り込みは RepoSection / WtCard が同じキーで行う)。編集モード中は解除する。
  並び替えの `move()` は dirOrder 全体の index で動くため、repo が隠れたまま drag すると操作結果がずれる
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
import type { Task, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { useArcadeStore } from "../arcade";
import { rpcPickAndOpen } from "../layout";
import { SessionLogDialog } from "../session-log";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { RepoSection } from "./features/repo";
import { useWorktreeActions } from "./features/worktree";
import RepoMenu from "./RepoMenu.vue";
import { rpcTaskRemove } from "./rpc";
import SidebarClock from "./SidebarClock.vue";
import TaskEditDialog from "./TaskEditDialog.vue";
import TaskMenu from "./TaskMenu.vue";
import { useDialogs } from "./useDialogs";
import { useRepoMenu } from "./useRepoMenu";
import { useSidebarData } from "./useSidebarData";
import { useTaskMenu } from "./useTaskMenu";
import { useWorktreeMenu } from "./useWorktreeMenu";
import VoicevoxPanel from "./VoicevoxPanel.vue";
import WorktreeMenu from "./WorktreeMenu.vue";
import IconLucideBot from "~icons/lucide/bot";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideMonitor from "~icons/lucide/monitor";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideVolume2 from "~icons/lucide/volume-2";
import IconLucideVolumeOff from "~icons/lucide/volume-off";

const repoStore = useRepoStore();
const worktreeStore = useWorktreeStore();
const terminalStore = useTerminalStore();
const notify = useNotificationStore();
const arcadeStore = useArcadeStore();
const { sfxEnabled } = storeToRefs(arcadeStore);
const { toggleSfx } = arcadeStore;

// useSidebarData の onMounted で全 repo の fetch / FsWatch / title sync が起動する。
// 戻り値は現状外側で使わないので呼び捨てる。
useSidebarData();

const { confirmRef, confirmMessage, showConfirm, closeConfirm, executeConfirm } = useDialogs();

const { isCreatingFor, selectDir, handleWorktreeSelect, addWorktree, handleWorktreeRemove } =
  useWorktreeActions({
    showConfirm,
  });

// --- メニュー ---
//
// worktree / task の ⋮ メニューはそれぞれ独立した popover singleton。
// SidebarPane は open() を呼ぶだけで、light-dismiss / アクション click の close 経路は
// composable が内部で扱う。

const { open: openWorktreeMenu } = useWorktreeMenu();
const { open: openTaskMenu } = useTaskMenu();
const { open: openRepoMenu } = useRepoMenu();

function onOpenWorktreeMenu(anchorEl: HTMLElement, worktree: WorktreeEntry, rootDir: string) {
  openWorktreeMenu(anchorEl, { worktree, rootDir });
}

function onOpenTaskMenu(anchorEl: HTMLElement, task: Task, rootDir: string) {
  openTaskMenu(anchorEl, { task, rootDir });
}

function onOpenRepoMenu(anchorEl: HTMLElement, rootDir: string) {
  openRepoMenu(anchorEl, { rootDir });
}

function onSelectWt(wt: WorktreeEntry) {
  // 同 wt 再クリック時の done 消化は worktreeStore.setOpen の selectionVersion 経由で
  // useSidebarData の watch が処理する。ここでは isActive 分岐せず常に setOpen を呼ぶ。
  handleWorktreeSelect(wt);
}

// 非 git project ヘッダ経路。dir 選択プリミティブに委譲して rootDir を active にする。
function onSelectRoot(rootDir: string) {
  selectDir(rootDir);
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
  // ⋮ メニューからの明示削除。main 側 taskStore.remove で永続化を消した後、
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
  const result = await tryCatch(rpcPickAndOpen());
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

// claude ビュー中は Claude セッションが動いている dir を持つ repo だけに絞る
// （terminal のタイル表示と対象を揃える）。編集モード中はフィルタを解除する。
// 隠れた repo が並び替え（move は dirOrder 全体の index で動く）や削除の対象から
// 漏れると操作結果がずれるため。
const visibleRootDirs = computed(() => {
  if (editMode.value || terminalStore.viewMode !== "claude") return repoStore.dirOrder;
  return repoStore.dirOrder.filter((rootDir) => {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined) return false;
    // 非 git project は worktree を持たないので rootDir 自身で判定する
    if (!repo.isGitRepo) return terminalStore.claudeActiveDirs.has(rootDir);
    return repo.worktrees.some((wt) => terminalStore.claudeActiveDirs.has(wt.path));
  });
});

// move() は dragend イベントの operation を見て新しい配列を返す
function onDragEnd(event: DragEndEvent) {
  repoStore.dirOrder = move(repoStore.dirOrder, event);
}

// --- アクティブ worktree のサイドバー追従 ---
//
// アクティブターミナル（= worktreeStore.dir）が変わったら、その wt がサイドバーで
// 見えるようにする。サイドバー操作で切り替えた場合は既に可視なので副作用なし
// （scrollIntoView block:nearest は範囲内なら no-op、属する repo は開いている）。
// ターミナルペイン側でのフォーカス移動など、サイドバー外の経路で dir が変わった
// ときに効く。immediate で起動直後 / フルリロード後（hydrate 済みの selectedDir）も
// 初回表示で追従させる。flush:post で常に DOM 更新後にコールバックを走らせ、immediate
// 初回でも scrollContainer / WtCard が mount 済みになることを Vue 内部のスケジューリングに
// 依存せず保証する。コールバック内の nextTick は expand（store 変更→再レンダー）と scroll
// の間で別途必要なため残す。
const scrollContainer = useTemplateRef<HTMLElement>("scrollContainer");

watch(
  () => worktreeStore.dir,
  async (dir) => {
    if (dir === undefined) return;
    // 編集モード中は全 section が強制 collapse され WtCard が描画されないため、
    // スクロール先が存在しない。追従はスキップする。
    if (editMode.value) return;
    // 畳まれた repo の中にいると WtCard が v-if で出ていないので、まず開く。
    const owner = repoStore.findRepoOwning(dir);
    if (owner !== undefined) repoStore.expand(owner.rootDir);
    // expand による WtCard の出現を待ってからスクロール先を引く。
    await nextTick();
    const container = scrollContainer.value;
    if (container === null) return;
    // path は `/` 等を含むので CSS.escape で属性セレクタ用にエスケープする。
    const el = container.querySelector(`[data-wt-path=${CSS.escape(dir)}]`);
    // block:nearest = 範囲内なら動かさず、範囲外のときだけ最小限スクロールする。
    el?.scrollIntoView({ block: "nearest" });
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <div class="_fx-sidebar-bg flex size-full flex-col">
    <!-- トップツールバー: view mode トグル + 編集モード -->
    <div class="_fx-toolbar flex items-center justify-between px-2 py-1">
      <div class="flex gap-0.5">
        <button
          type="button"
          aria-label="Active worktree"
          title="Active worktree"
          :aria-pressed="terminalStore.viewMode === 'wt'"
          class="grid size-7 place-items-center rounded-sm text-foreground-low hover:bg-panel hover:text-foreground"
          :class="terminalStore.viewMode === 'wt' && 'bg-element text-foreground'"
          @click="terminalStore.viewMode = 'wt'"
        >
          <IconLucideMonitor class="text-base" />
        </button>
        <button
          type="button"
          aria-label="Claude terminals"
          title="Claude terminals"
          :aria-pressed="terminalStore.viewMode === 'claude'"
          :disabled="terminalStore.claudeActiveLeafIds.length === 0"
          class="grid size-7 place-items-center rounded-sm text-foreground-low hover:bg-panel hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground-muted disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
          :class="terminalStore.viewMode === 'claude' && 'bg-element text-foreground'"
          @click="terminalStore.viewMode = 'claude'"
        >
          <IconLucideBot class="text-base" />
        </button>
      </div>
      <div class="flex items-center gap-2">
        <SidebarClock />
        <button
          type="button"
          :aria-pressed="sfxEnabled"
          aria-label="Sound effects"
          :title="sfxEnabled ? 'Mute sound effects' : 'Enable sound effects'"
          class="grid size-7 place-items-center rounded-sm text-foreground-low transition-colors hover:bg-panel hover:text-foreground"
          @click="toggleSfx"
        >
          <component :is="sfxEnabled ? IconLucideVolume2 : IconLucideVolumeOff" class="text-base" />
        </button>
        <button
          type="button"
          :aria-label="editMode ? 'Exit edit mode' : 'Edit repositories'"
          :title="editMode ? 'Done' : 'Edit repositories'"
          class="grid size-7 place-items-center rounded-sm transition-colors"
          :class="
            editMode
              ? 'bg-primary text-foreground hover:bg-primary-hover'
              : 'text-foreground-low hover:bg-panel hover:text-foreground'
          "
          @click="toggleEditMode"
        >
          <component :is="editMode ? IconLucideCheck : IconLucidePencil" class="text-base" />
        </button>
      </div>
    </div>

    <div ref="scrollContainer" class="_thin-scrollbar flex flex-1 flex-col overflow-y-scroll py-4">
      <DragDropProvider @drag-end="onDragEnd">
        <RepoSection
          v-for="(rootDir, i) in visibleRootDirs"
          :key="rootDir"
          :root-dir="rootDir"
          :index="i"
          :edit-mode="editMode"
          :active-dir="worktreeStore.dir"
          :is-creating="isCreatingFor(rootDir)"
          :get-focused-pty-id="getFocusedPtyId"
          @remove-repo="onRemoveRepo"
          @select-root="onSelectRoot"
          @select-wt="onSelectWt"
          @select-task="onSelectTask"
          @add-worktree="addWorktree"
          @open-worktree-menu="onOpenWorktreeMenu"
          @open-task-menu="onOpenTaskMenu"
          @open-repo-menu="onOpenRepoMenu"
        />
      </DragDropProvider>

      <button
        v-if="editMode"
        type="button"
        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground-low hover:bg-panel hover:text-foreground"
        title="Add directory"
        @click="onAddDir"
      >
        <IconLucidePlus class="size-4 shrink-0" />
        <span>Add directory</span>
      </button>
    </div>

    <!-- ⋮ メニュー（worktree / task / repo） -->
    <WorktreeMenu @remove="(wt, rd) => handleWorktreeRemove(rd, wt)" />
    <TaskMenu @remove="(task, rd) => handleTaskRemove(rd, task)" />
    <RepoMenu />

    <!-- task title 編集 dialog -->
    <TaskEditDialog />

    <!-- セッションログ表示 dialog -->
    <SessionLogDialog />

    <!-- 確認ダイアログ -->
    <dialog
      ref="confirmRef"
      class="backdrop:bg-overlay"
      @click="$event.target === confirmRef && closeConfirm()"
    >
      <div class="space-y-4 rounded-lg border border-border bg-background p-4 text-foreground">
        <p class="text-sm">{{ confirmMessage }}</p>
        <div class="flex justify-end gap-2">
          <button
            class="rounded-sm px-3 py-1.5 text-sm text-foreground-low hover:bg-panel"
            @click="closeConfirm"
          >
            Cancel
          </button>
          <button
            class="rounded-sm bg-destructive px-3 py-1.5 text-sm text-foreground hover:bg-destructive-hover"
            @click="executeConfirm"
          >
            OK
          </button>
        </div>
      </div>
    </dialog>

    <!-- VOICEVOX -->
    <VoicevoxPanel />
  </div>
</template>
