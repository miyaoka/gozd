<doc lang="md">
全 repo 横断の task を最終活動の新しい順に並べる中央ダイアログ。並列セッションの
「次にどこへ注意を向けるか」を選ぶ受信箱で、行の確定は該当 worktree を選択して
セッションを開く / resume / focus する (openTaskSession)。

タイトルと repo ラベルを横断して絞り込める。一覧が空のとき、task が無いのか絞り込みで
消えたのかを書き分ける。

受理はダイアログを閉じてから走らせる。閉じること自体が再入への唯一の防壁
(RevivePickerDialog と同じ理由)。
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";
import { fuzzyMatch, useListNavigation } from "../palette";
import { openTaskSession } from "../sidebar";
import { useTerminalStore } from "../terminal";
import type { DashboardRow } from "./collectDashboardRows";
import { collectDashboardRows } from "./collectDashboardRows";
import DashboardDetailPane from "./DashboardDetailPane.vue";
import DashboardTaskRow from "./DashboardTaskRow.vue";
import { useDashboard } from "./useDashboard";

const contextKeys = useContextKeys();
const repoStore = useRepoStore();
const terminalStore = useTerminalStore();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { showSignal } = useDashboard();

const query = ref("");

// 詳細ペインの取得 (RPC + fs watch) を閉じている間に走らせないための開閉状態。
// dialog.open は非リアクティブなので自前で持つ
const isOpen = ref(false);

const rows = computed((): DashboardRow[] =>
  collectDashboardRows(repoStore.poolDirs, repoStore.repos, (sessionId) =>
    terminalStore.getClaudeStatusBySessionId(sessionId),
  ),
);

const filteredRows = computed((): DashboardRow[] => {
  const q = query.value;
  if (q === "") return rows.value;

  const scored: Array<{ row: DashboardRow; score: number }> = [];
  for (const row of rows.value) {
    const result = fuzzyMatch(`${row.title} ${row.repoName} ${row.branch}`, q);
    if (result) {
      scored.push({ row, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
});

const itemCount = computed(() => filteredRows.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

const selectedRow = computed((): DashboardRow | undefined =>
  isOpen.value ? filteredRows.value[selectedIndex.value] : undefined,
);

/** task 自体が無いか、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() => (rows.value.length === 0 ? "No tasks" : "No matching tasks"));

// filteredRows はライブデータ (repo fetch の順次完了 / hooks の状態変化) でも再計算される。
// revive picker と違い「一覧が変わった = 絞り込みが変わった」ではないので、無条件 reset に
// すると起動直後のデータ流入のたびに選択が先頭へ戻る。query 変更のときだけ reset し、
// データ由来の変化では選択中の task.id を新しい配列で探して選択位置を追従させる。
let lastQuery = "";
watch(filteredRows, (next, prev) => {
  if (query.value !== lastQuery) {
    lastQuery = query.value;
    reset();
    return;
  }
  const selected = prev[selectedIndex.value];
  if (selected === undefined) return;
  const index = next.findIndex((row) => row.task.id === selected.task.id);
  if (index !== -1) {
    selectedIndex.value = index;
    return;
  }
  // 選択していた行が消えた: 位置を維持しつつ末尾に clamp する
  selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, next.length - 1));
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  reset();
  dialog.showModal();
  isOpen.value = true;
  contextKeys.set("dashboardVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

// Escape (UA 既定) 経由の close もここを通る
function onDialogClose() {
  isOpen.value = false;
  contextKeys.set("dashboardVisible", false);
}

function close() {
  dialogRef.value?.close();
  onDialogClose();
}

function acceptSelected() {
  const row = filteredRows.value[selectedIndex.value];
  if (!row) return;
  close();
  // 非アクティブ repo list / 折り畳み repo の worktree でもサイドバー表示が追従するよう、
  // 選択の前に list と折り畳みを開く
  repoStore.activateRepoListContaining(row.rootDir);
  repoStore.expand(row.rootDir);
  openTaskSession(row.dir, row.task);
}

function handleKeydown(e: KeyboardEvent) {
  if (isIMEActive(e)) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "PageDown":
      e.preventDefault();
      movePage(1);
      break;
    case "PageUp":
      e.preventDefault();
      movePage(-1);
      break;
    case "Enter":
      e.preventDefault();
      acceptSelected();
      break;
  }
}

useEventListener(dialogRef, "click", (e: MouseEvent) => {
  if (e.target === dialogRef.value) {
    close();
  }
});
</script>

<template>
  <dialog
    ref="dialog"
    class="_dashboard-dialog"
    aria-label="Task dashboard"
    @keydown="handleKeydown"
    @close="onDialogClose"
  >
    <div
      class="w-[min(1200px,calc(100vw-4rem))] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Filter tasks..."
          aria-label="Filter tasks"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
      </div>
      <div class="flex h-[min(640px,70vh)]">
        <div class="flex w-[820px] shrink-0 flex-col border-r border-border">
          <div
            v-if="filteredRows.length === 0"
            role="status"
            class="flex flex-1 items-center justify-center px-3 py-8 text-sm text-foreground-low"
          >
            {{ emptyMessage }}
          </div>
          <!--
            カラム定義は親 grid が 1 回だけ持ち、各行は subgrid でトラックを継承する
            (行間のカラム整列と内容ベースのカラム幅を両立する CSS 構造)。

            - 両端の 4px は gutter トラック (gap 8px と合わせて左右 12px の余白)。行自身は
              水平 padding を持たない (subgrid 行の padding は端トラックの内容領域を侵食する)
            - fit-content (intrinsic track) は fr より先に幅を確保する仕様のため、最重要
              カラムのタイトルは minmax の最小値で幅を保証する

            実データ幅の Chrome 実測で [icon 20, title 450, repo 103, branch 103, age 88]
            に解決することを検証済み。
          -->
          <div
            v-else
            ref="list"
            class="grid flex-1 content-start gap-x-2 overflow-y-auto py-1"
            style="
              grid-template-columns:
                4px 20px minmax(450px, 1fr) fit-content(140px)
                fit-content(140px) 88px 4px;
            "
          >
            <div
              v-for="(row, i) in filteredRows"
              :key="row.task.id"
              class="col-span-full grid cursor-pointer grid-cols-subgrid items-center py-1 text-sm"
              :class="
                i === selectedIndex
                  ? 'bg-selection text-foreground'
                  : 'text-foreground hover:bg-element-hover'
              "
              @click="
                () => {
                  selectedIndex = i;
                  acceptSelected();
                }
              "
            >
              <DashboardTaskRow :row="row" />
            </div>
          </div>
        </div>
        <DashboardDetailPane :row="selectedRow" />
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._dashboard-dialog {
  margin: 15vh auto 0;
}

._dashboard-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
