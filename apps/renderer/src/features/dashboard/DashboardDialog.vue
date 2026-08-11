<doc lang="md">
全 repo 横断の task を新しい順に並べる中央ダイアログ。並列セッションの
「次にどこへ注意を向けるか」を選ぶ受信箱で、行の確定は該当 worktree を選択して
セッションを開く / resume / focus する (openTaskSession)。

タイトル・repo 名・ブランチ名・GitHub owner を横断して絞り込める (owner はカラムに
表示しないが検索対象に含める)。

## 並び順は開いている間凍結する

一覧の中身は hooks の状態変化でライブ再計算されるが、並びまで live にするとクリック
直前に行が入れ替わり、意図しない task を確定する事故が起きる。開いたときに並び順
(task.id 列) を確定し、行の中身だけを live 更新する。開いている間に増えた task は
次回 open で現れる。

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

// 開閉状態は context key を SSOT に導出する (picker 一家と同じ運用。dialog.open は非リアクティブ)
const isOpen = computed(() => contextKeys.get("dashboardVisible"));

// 閉じている間は空にして、hooks イベントごとの全 repo 走査と詳細ペインの取得を止める
const rows = computed((): DashboardRow[] =>
  isOpen.value
    ? collectDashboardRows(repoStore.poolDirs, repoStore.repos, (sessionId) =>
        terminalStore.getClaudeStatusBySessionId(sessionId),
      )
    : [],
);

// 開いている間の並び順の凍結 (doc ブロック参照)。open 時の task.id 列が並びの SSOT
const frozenOrder = ref<string[]>([]);

const orderedRows = computed((): DashboardRow[] => {
  const byId = new Map(rows.value.map((row) => [row.task.id, row]));
  return frozenOrder.value.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
});

const filteredRows = computed((): DashboardRow[] => {
  const q = query.value;
  if (q === "") return orderedRows.value;

  const scored: Array<{ row: DashboardRow; score: number }> = [];
  for (const row of orderedRows.value) {
    // owner (org) は UI 表示しないが絞り込み対象には含める
    const result = fuzzyMatch(`${row.title} ${row.repoName} ${row.branch} ${row.owner ?? ""}`, q);
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

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が list → empty の
 * 状態遷移を確実に読み上げる (RevivePickerDialog と同じ理由)。
 */
const statusMessage = computed(() => {
  if (filteredRows.value.length > 0) return "";
  return rows.value.length === 0 ? "No tasks" : "No matching tasks";
});

watch(query, () => {
  reset();
});

// 行の削除 (task remove / worktree 削除) で選択が末尾からはみ出したときだけ clamp する
watch(itemCount, (count) => {
  if (selectedIndex.value >= count) selectedIndex.value = Math.max(0, count - 1);
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  contextKeys.set("dashboardVisible", true);
  frozenOrder.value = rows.value.map((row) => row.task.id);
  reset();
  dialog.showModal();
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

// Escape (UA 既定) 経由の close もここを通る
function onDialogClose() {
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
          role="combobox"
          aria-controls="dashboard-listbox"
          :aria-expanded="filteredRows.length > 0"
          :aria-activedescendant="
            filteredRows.length > 0 ? `dashboard-option-${selectedIndex}` : undefined
          "
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
      </div>
      <div class="flex h-[min(640px,70vh)]">
        <!-- 幅の下限保証: 狭いウィンドウでは list 側が縮み、詳細ペインに最低 280px を残す -->
        <div class="flex w-[min(820px,calc(100%-280px))] shrink-0 flex-col border-r border-border">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            :class="
              statusMessage
                ? 'flex flex-1 items-center justify-center px-3 py-8 text-sm text-foreground-low'
                : ''
            "
          >
            {{ statusMessage }}
          </div>
          <!--
            カラム定義は親 grid が 1 回だけ持ち、各行は subgrid でトラックを継承する
            (行間のカラム整列と内容ベースのカラム幅を両立する CSS 構造)。

            - 両端の 4px は gutter トラック (gap 8px と合わせて左右 12px の余白)。行自身に
              水平 padding を持たせない (subgrid 行の padding は端トラックの内容領域を侵食する)
            - fit-content (intrinsic track) は fr より先に幅を確保する仕様のため、最重要
              カラムのタイトルは minmax の最小値で幅を保証する
          -->
          <div
            v-if="filteredRows.length > 0"
            id="dashboard-listbox"
            ref="list"
            role="listbox"
            aria-label="Tasks"
            class="grid flex-1 content-start gap-x-2 overflow-y-auto py-1"
            style="
              grid-template-columns:
                4px 20px minmax(450px, 1fr) fit-content(140px)
                fit-content(140px) 88px 4px;
            "
          >
            <div
              v-for="(row, i) in filteredRows"
              :id="`dashboard-option-${i}`"
              :key="row.task.id"
              role="option"
              :aria-selected="i === selectedIndex"
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
