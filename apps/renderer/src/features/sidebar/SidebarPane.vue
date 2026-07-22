<doc lang="md">
左端のサイドバー。window 内に同居する repo を repo list 単位で切り替えて並べる。
（機能名は repo list、UI 文言は "List" 単体。非 git project も内部慣習どおり repo に含む）

## レイアウト構成

- **トップツールバー**: 左に view mode トグル (active worktree / claude terminals)、右に時計 / SFX
- **repo list バー**: 編集トグルをツールバーではなくこのバーに置くのは、編集の対象がこの
  バー以下のリストエリアに閉じるため（配置と作用範囲の対応づけ）。表示は 2 態:
  - 通常モード: chip 列（クリックでアクティブ repo list を切り替えるだけ）+ 右端に鉛筆
  - 編集モード: 専用ヘッダ（左に "Edit list" タイトル / 右に Done ボタン）+ 全幅の縦一覧
    (`ListRow`)。行 drag で list の並び替え、行クリックで切り替え、行 hover の ⋮ で
    ListMenu（Rename → ListEditDialog / Delete → 確認ダイアログ）。末尾に `New list`。
    rename / delete を常時露出させないのは delete が気軽に押す操作ではないため
    （repo / wt 行の ⋮ メニューと同じ流儀）。トグルを一覧の右隣に置くと右端の縦スペースが
    列ごと専有されるため、編集中の出口はヘッダ行の Done に置く
- **アクティブ repo list の dirOrder の各 repo** に対して `RepoSection` を縦に並べる。
  空リストは通常モードで操作の手がかりが消えるため、empty state（"This list is empty" +
  Edit list ボタンで編集モードへ）を出す
- **claude ビュー中のフィルタ**: `terminalStore.claudeActiveDirs` に該当する dir を持つ repo だけ表示
  (worktree / task の絞り込みは RepoSection / WtCard が同じキーで行う)。編集モード中は解除する。
  フィルタ対象は repo list ではなく **プール全体 (poolDirs)**: terminal のタイルは repo list と
  無関係に全 dir から出るため、repo list で絞るとタイルとサイドバーの見えている対象がずれる。
  並び替えの `move()` は dirOrder 全体の index で動くため、repo が隠れたまま drag すると操作結果がずれる
- 各 RepoSection は header (folder + repo 名) + WtCard 列 (main wt 先頭固定) + `+ New worktree`
- 編集モード中: 全 section が collapsed + drag で並び替え + ✕ で削除。リスト末尾は
  divider で区切った 2 セクション: 「Add from other lists」（既存プール repo の候補。
  RepoIcon + repo 名の行 + 末尾 + で "既にある repo を載せる" ことを示す）と
  「Open directory…」（folder-plus。ディスクから新規に開く。ellipsis はダイアログが
  開くことを示す macOS 慣習）

## 編集モードの ✕ の分岐

repo が他 repo list にも属していれば「アクティブ repo list から外すだけ」（非破壊、確認なし）。
最後の所属 repo list なら従来どおり「window から解除」（確認 + PTY cleanup）。分岐は
`repoListsContaining` で判定し、RepoSection に `removes-from-window` を渡してラベルも変える

## クリック挙動

- WtCard ヘッダクリック: `worktreeStore.dir` をその wt に切り替え。focus は wt の `focusedLeafId` 維持
- TaskRow クリック: wt を active にしたうえで、task に対応する PTY の leaf を `focusPane`
- focus 解決: `layoutsByDir[dir].focusedLeafId` (生きていれば) → 無効なら `findFirstLeaf(root)` (ensureLayout が担保)
- ⋮ メニュー: worktree 行は WorktreeMenu、task 行は TaskMenu に委譲

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
import { RepoIcon } from "../repo-icon";
import { SessionLogDialog } from "../session-log";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { RepoSection } from "./features/repo";
import { useWorktreeActions } from "./features/worktree";
import ListEditDialog from "./ListEditDialog.vue";
import ListMenu from "./ListMenu.vue";
import ListRow from "./ListRow.vue";
import RepoMenu from "./RepoMenu.vue";
import { rpcTaskRemove, rpcTaskRemoveByWorktree } from "./rpc";
import SidebarClock from "./SidebarClock.vue";
import TaskEditDialog from "./TaskEditDialog.vue";
import TaskMenu from "./TaskMenu.vue";
import { useDialogs } from "./useDialogs";
import { useListEditing } from "./useListEditing";
import { useListMenu } from "./useListMenu";
import { useRepoMenu } from "./useRepoMenu";
import { useSidebarData } from "./useSidebarData";
import { useTaskMenu } from "./useTaskMenu";
import { useWorktreeMenu } from "./useWorktreeMenu";
import { filterClaudeActiveRootDirs, worktreeDisplayName } from "./utils";
import VoicevoxPanel from "./VoicevoxPanel.vue";
import WorktreeMenu from "./WorktreeMenu.vue";
import IconLucideBot from "~icons/lucide/bot";
import IconLucideFolderPlus from "~icons/lucide/folder-plus";
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
const { open: openListMenu } = useListMenu();

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

function handleWorktreeTasksRemove(rootDir: string, wt: WorktreeEntry) {
  // worktree ⋮ メニューからの一括削除。worktree 削除と違い wt 自体は残る（remove 不可の
  // main worktree で滞留 task 行を一掃する主用途）。複数 task を不可逆に消すため確認を挟む。
  // 削除後は handleTaskRemove と同じく requestRefresh で server の真値を取り直す
  showConfirm(
    `Remove all tasks (${wt.tasks.length}) in "${worktreeDisplayName(wt)}"?`,
    async () => {
      const result = await tryCatch(
        rpcTaskRemoveByWorktree({ dir: rootDir, worktreeDir: wt.path }),
      );
      if (!result.ok) {
        notify.error("Failed to remove tasks", result.error);
        return;
      }
      repoStore.requestRefresh(rootDir);
    },
  );
}

function onRemoveRepo(rootDir: string) {
  // 他 repo list にも属している repo はアクティブ repo list から外すだけ。
  // 表示から消えるだけで PTY / watch は生きるため、確認なしの可逆操作とする
  if (repoStore.repoListsContaining(rootDir).length > 1) {
    repoStore.removeFromActiveRepoList(rootDir);
    return;
  }
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
// - リスト末尾に `Open directory…` ボタンが出現
// 通常モード:
// - 各 section の永続 collapse 状態が反映される
// - drag は無効、✕ は非表示、+ は非表示

const editMode = ref(false);

function toggleEditMode() {
  editMode.value = !editMode.value;
}

// claude ビュー中は Claude セッションが動いている dir を持つ repo だけに絞る。
// フィルタ母集団はアクティブ repo list ではなくプール全体（理由は <doc> 参照）。
// 編集モード中はフィルタ解除（理由は <doc> 参照）。
const visibleRootDirs = computed(() => {
  if (editMode.value || terminalStore.viewMode !== "claude") return repoStore.dirOrder;
  return filterClaudeActiveRootDirs(
    repoStore.poolDirs,
    repoStore.repos,
    terminalStore.claudeActiveDirs,
  );
});

// --- repo list 操作 ---
//
// rename / delete は list 行（編集モードの縦一覧）の ⋮ メニュー経由の明示操作に限定する。
// 常時ボタンで露出させないのは、特に delete が気軽に押す操作ではないため。
// Rename は編集ダイアログ (ListEditDialog)、Delete は確認ダイアログの二段階。

const listEditing = useListEditing();

// list 行の ⋮ trigger。anchor 要素基準で ListMenu を開く（RepoMenu と同じ anchor 方式）
function onOpenListMenu(anchorEl: HTMLElement, listId: string) {
  openListMenu(anchorEl, { listId });
}

// 編集モードの縦一覧の drag 並び替え。repoLists 配列の順序が list の表示順の SSOT
function onListDragEnd(event: DragEndEvent) {
  repoStore.repoLists = move(repoStore.repoLists, event);
}

function onAddRepoList() {
  const id = repoStore.addRepoList(`List ${repoStore.repoLists.length + 1}`);
  // 生成直後に rename ダイアログを開き、その場で名前を付けさせる（Cancel なら仮名のまま）
  listEditing.open(id);
}

function onRemoveRepoList(listId: string) {
  const target = repoStore.repoLists.find((p) => p.id === listId);
  if (target === undefined) return;
  const others = repoStore.repoLists.filter((p) => p.id !== listId);
  const [firstOther] = others;
  if (firstOther === undefined) return;
  // この repo list にしか属さない repo は削除で消えず先頭 repo list へ移る（store 側の
  // union 不変条件）。挙動が見た目から自明でないため、確認文で移動先を予告する
  const otherUnion = new Set(others.flatMap((p) => p.dirOrder));
  const orphanCount = target.dirOrder.filter((d) => !otherUnion.has(d)).length;
  const orphanNote =
    orphanCount > 0
      ? ` ${orphanCount} repo(s) only in this list will move to "${firstOther.name}".`
      : "";
  showConfirm(`Delete list "${target.name}"?${orphanNote}`, async () => {
    repoStore.removeRepoList(listId);
  });
}

// 編集モードでアクティブ repo list に追加できるプール repo（他 repo list にのみ所属）
const addableRootDirs = computed(() =>
  repoStore.poolDirs.filter((d) => !repoStore.dirOrder.includes(d)),
);

// 候補行の表示用ヘルパー（テンプレートに optional chain の連鎖を書かない）
function repoNameOf(rootDir: string): string {
  return repoStore.repos[rootDir]?.repoName ?? rootDir;
}
function repoOwnerOf(rootDir: string): string {
  return repoStore.repos[rootDir]?.githubIdentity?.owner ?? "";
}

/** RepoSection の ✕ が window 解除（破壊的）になるか。ラベル出し分けに使う */
function removesFromWindow(rootDir: string): boolean {
  return repoStore.repoListsContaining(rootDir).length <= 1;
}

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
      </div>
    </div>

    <!-- repo list バー: 編集トグルはツールバーではなくこのエリアに置く。ツールバーは
         view mode 等のグローバル操作で、編集はこのバー以下のリストエリアに閉じるため
         配置で対応づける -->
    <!-- 通常モード: chip 列（切り替えのみ）+ 右端に鉛筆 -->
    <div v-if="!editMode" class="flex items-start gap-1 px-2 pt-3 pb-1">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <button
          v-for="pl in repoStore.repoLists"
          :key="pl.id"
          type="button"
          :aria-pressed="pl.id === repoStore.activeRepoListId"
          :title="pl.name"
          class="max-w-full truncate rounded-full px-2.5 py-0.5 text-xs transition-colors"
          :class="
            pl.id === repoStore.activeRepoListId
              ? 'bg-element-active text-foreground'
              : 'text-foreground-low hover:bg-panel hover:text-foreground'
          "
          @click="repoStore.setActiveRepoList(pl.id)"
        >
          {{ pl.name }}
        </button>
      </div>
      <button
        type="button"
        aria-label="Edit list"
        title="Edit list"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low transition-colors hover:bg-panel hover:text-foreground"
        @click="toggleEditMode"
      >
        <IconLucidePencil class="size-3.5" />
      </button>
    </div>
    <!-- 編集モード: 専用ヘッダ（左にタイトル / 右に Done）+ 全幅の縦一覧。
         トグルを一覧の右隣に置くと右端の縦スペースが列ごと専有されるため、ヘッダ行に出す -->
    <template v-else>
      <div class="flex items-center justify-between px-2 pt-3 pb-1">
        <span class="px-1 text-sm font-semibold">Edit list</span>
        <button
          type="button"
          class="rounded-sm bg-primary px-2.5 py-0.5 text-xs text-foreground hover:bg-primary-hover"
          @click="toggleEditMode"
        >
          Done
        </button>
      </div>
      <!-- 縦一覧: 行 drag で並び替え、行 hover の ⋮ で ListMenu (Rename / Delete) -->
      <div class="flex flex-col gap-0.5 px-2 pb-1">
        <DragDropProvider @drag-end="onListDragEnd">
          <ListRow
            v-for="(pl, i) in repoStore.repoLists"
            :key="pl.id"
            :list-id="pl.id"
            :name="pl.name"
            :index="i"
            :active="pl.id === repoStore.activeRepoListId"
            @select="repoStore.setActiveRepoList"
            @open-menu="onOpenListMenu"
          />
        </DragDropProvider>
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground-low hover:bg-panel hover:text-foreground"
          @click="onAddRepoList"
        >
          <IconLucidePlus class="size-3.5 shrink-0" />
          <span>New list</span>
        </button>
      </div>
    </template>

    <!-- 上 padding は repo list バー側の pb-1 が担うため詰める（pt-4 を残すと二重で不自然な
         空白になる）。下は overscroll の余白として pb-4 を保つ -->
    <div
      ref="scrollContainer"
      class="_thin-scrollbar flex flex-1 flex-col overflow-y-scroll pt-1 pb-4"
    >
      <!-- 空リストの empty state: 通常モードでは repo が 1 つも描画されず操作の手がかりが
           消えるため、編集モード（Add from other lists / Open directory… が出る）への
           導線を明示する。編集モード中は追加導線自体が出ているので不要 -->
      <div
        v-if="!editMode && visibleRootDirs.length === 0"
        class="flex flex-col items-center gap-3 px-4 py-8"
      >
        <p class="text-xs text-foreground-muted">This list is empty</p>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md bg-element px-3 py-1.5 text-xs text-foreground hover:bg-element-hover"
          @click="editMode = true"
        >
          <IconLucidePencil class="size-3.5" />
          <span>Edit list</span>
        </button>
      </div>

      <DragDropProvider @drag-end="onDragEnd">
        <RepoSection
          v-for="(rootDir, i) in visibleRootDirs"
          :key="rootDir"
          :root-dir="rootDir"
          :index="i"
          :edit-mode="editMode"
          :removes-from-window="removesFromWindow(rootDir)"
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

      <!-- 編集モード: 既存プール repo（他 repo list にのみ所属）の候補。RepoSection と同じ
           RepoIcon + repo 名の行で「既にある repo をこの repo list に載せる」ことを示し、
           ディスクからの新規追加 (Open directory…) と描き分ける -->
      <div
        v-if="editMode && addableRootDirs.length > 0"
        class="mx-1 mt-2 border-t border-border-subtle pt-2"
      >
        <div class="px-2 pb-1 text-xs text-foreground-muted">Add from other lists</div>
        <button
          v-for="rootDir in addableRootDirs"
          :key="rootDir"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-foreground-low hover:bg-panel hover:text-foreground"
          :title="rootDir"
          :aria-label="`Add ${repoNameOf(rootDir)} to this repo list`"
          @click="repoStore.ensureInActiveRepoList(rootDir)"
        >
          <RepoIcon :name="repoNameOf(rootDir)" :owner="repoOwnerOf(rootDir)" />
          <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">
            {{ repoNameOf(rootDir) }}
          </span>
          <IconLucidePlus class="size-4 shrink-0" />
        </button>
      </div>

      <!-- 新規ディレクトリ追加。既存 repo 候補とは divider で分離し、folder-plus で
           「ディスクから新しく開く」操作であることを示す -->
      <div v-if="editMode" class="mx-1 mt-2 border-t border-border-subtle pt-2">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground-low hover:bg-panel hover:text-foreground"
          title="Open directory…"
          @click="onAddDir"
        >
          <IconLucideFolderPlus class="size-4 shrink-0" />
          <span>Open directory…</span>
        </button>
      </div>
    </div>

    <!-- ⋮ メニュー（worktree / task / repo） -->
    <WorktreeMenu
      @remove="(wt, rd) => handleWorktreeRemove(rd, wt)"
      @remove-all-tasks="(wt, rd) => handleWorktreeTasksRemove(rd, wt)"
    />
    <TaskMenu @remove="(task, rd) => handleTaskRemove(rd, task)" />
    <RepoMenu />
    <ListMenu @rename="(id) => listEditing.open(id)" @remove="onRemoveRepoList" />

    <!-- list 名編集 dialog -->
    <ListEditDialog />

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
