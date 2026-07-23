<doc lang="md">
Full-text search dialog (Find in Files), opened by Cmd+Shift+F.

## Behavior

- Centered modal `<dialog>`, mirroring FilePickerDialog (Go to File): input at top,
  scrollable result list below, backdrop click / Escape to close.
- Results stream in per file from rg. Each file is a non-selectable header row; under it
  come line rows in file order. Match lines highlight the matched ranges (primary); context
  lines (surrounding lines) render dimmed with no highlight.
- Arrow keys navigate line rows only (headers are skipped via `selectableIndices`), Enter
  opens the selected line. Clicking a line opens it too. Opening closes the dialog and reveals
  the file in preview at that line (`forceSelect(target, line+1)`, 1-based per Monaco).

## Accessibility

- WAI-ARIA listbox: the result list is `role="listbox"`, line rows are `role="option"` with
  `aria-selected`. The input is `role="combobox"` pointing at the active option via
  `aria-activedescendant` so focus stays in the input while arrows move the selection.
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { isIMEActive } from "../../shared/command";
import { useListNavigation } from "../palette";
import { usePreviewStore } from "../preview";
import { useWorktreeStore } from "../worktree";
import { segmentLine, type LineSegment } from "./segmentLine";
import { useSearchStore, type SearchFileGroup } from "./useSearchStore";

const store = useSearchStore();
const previewStore = usePreviewStore();
const worktreeStore = useWorktreeStore();

const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

/**
 * 描画する line 行の上限。仮想化を持たないため、DOM 爆発（数万行）を防ぐキャップ。
 * 超過分は「絞り込め」と促す（VS Code も 20000 で subset 表示に切り替える）。
 */
const MAX_RENDERED_LINES = 2000;

/** ヘッダー行（ファイル）と行結果を 1 本のフラット列にする。DOM の直接子と 1:1 対応させ、
 *  useListNavigation の children[index] スクロール追従が成立する。
 *  ハイライト分割（segmentLine）は行構築時に一度だけ計算して `segments` に持たせる
 *  （テンプレ v-for で毎行呼ぶと再描画のたびに全行で再計算されるため）。 */
type Row =
  | { kind: "file"; path: string }
  | {
      kind: "line";
      group: SearchFileGroup;
      line: number;
      isContext: boolean;
      segments: LineSegment[];
    };

/** rows と「上限で切り詰めたか」を 1 度の走査で作る（computed 内で side-effect を持たない）。 */
const view = computed<{ rows: Row[]; truncated: boolean }>(() => {
  const rows: Row[] = [];
  let lineCount = 0;
  let truncated = false;
  for (const group of store.results) {
    if (lineCount >= MAX_RENDERED_LINES) {
      truncated = true;
      break;
    }
    rows.push({ kind: "file", path: group.path });
    for (const lineResult of group.lines) {
      if (lineCount >= MAX_RENDERED_LINES) {
        truncated = true;
        break;
      }
      const ranges = lineResult.isContext ? [] : lineResult.ranges;
      rows.push({
        kind: "line",
        group,
        line: lineResult.line,
        isContext: lineResult.isContext,
        segments: segmentLine(lineResult.text, ranges),
      });
      lineCount++;
    }
  }
  return { rows, truncated };
});

const rows = computed(() => view.value.rows);
const truncated = computed(() => view.value.truncated);

const itemCount = computed(() => rows.value.length);
/** 選択可能なのは line 行のみ。file ヘッダーはスキップする。 */
const selectableIndices = computed(() =>
  rows.value.flatMap((row, i) => (row.kind === "line" ? [i] : [])),
);

const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
  selectableIndices,
});

const listVisible = computed(() => rows.value.length > 0);

/** 検索状況の 1 行サマリ。file-picker の status region と同じ役割。 */
const statusMessage = computed(() => {
  if (store.query === "") return "";
  if (store.running) return "Searching…";
  if (store.fileCount === 0) return "No results found";
  const base = `${store.matchCount} results in ${store.fileCount} files${store.limitHit ? " (limited)" : ""}`;
  // 描画キャップに達したら、全件は出していないことを明示する
  return truncated.value ? `${base} · showing first ${MAX_RENDERED_LINES}` : base;
});

// 選択が selectable 集合の外に落ちたときだけ先頭 line 行へスナップする。
// - 結果が現れた瞬間: 0（file ヘッダ）は selectable 外 → 先頭マッチ行へスナップ（事前選択）
// - ストリーム中: 選択がまだ有効なら動かさない（結果到着中の矢印移動が跳ねない）
// - 検索条件変更で結果が入れ替わり旧 index が新集合に無い: 先頭へスナップ
watch(selectableIndices, (indices) => {
  if (!indices.includes(selectedIndex.value)) reset();
});

// command からの show 要求で dialog を開き、入力へ focus + select する
watch(
  () => store.showSignal,
  () => {
    const dialog = dialogRef.value;
    if (!dialog || dialog.open) {
      // 表示中の再押下でも入力へ focus + select する（VS Code の Find in Files と同じ）
      inputRef.value?.focus();
      inputRef.value?.select();
      return;
    }
    dialog.showModal();
    void nextTick(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
      scrollToSelected();
    });
  },
);

function close(): void {
  dialogRef.value?.close();
}

/**
 * line 行を preview で開く。既定は dialog を閉じる（file-picker の accept と同じ）。
 * `keepOpen`（Cmd 押下）のときは閉じずに残し、結果を次々に覗けるようにする。
 */
function openRow(row: Row, keepOpen: boolean): void {
  if (row.kind !== "line") return;
  if (worktreeStore.dir === undefined) return;
  if (!keepOpen) close();
  // preview / worktree は 1-based 行番号を期待する（Monaco 契約）。結果は 0-based
  previewStore.forceSelect({ kind: "worktreeRelative", relPath: row.group.path }, row.line + 1);
}

function openSelected(keepOpen: boolean): void {
  const row = rows.value[selectedIndex.value];
  if (row !== undefined) openRow(row, keepOpen);
}

function handleKeydown(e: KeyboardEvent): void {
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
      // Cmd+Enter は dialog を残したまま preview を開く（Cmd+クリックのキーボード等価）
      openSelected(e.metaKey);
      break;
  }
}

// backdrop クリックで閉じる（file-picker と同じ）
useEventListener(dialogRef, "click", (e: MouseEvent) => {
  if (e.target === dialogRef.value) close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="_search-dialog"
    aria-label="Find in files"
    @keydown="handleKeydown"
    @close="store.clear()"
  >
    <div
      class="flex max-h-[70vh] w-[720px] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <!-- 入力 + トグル -->
      <div class="flex items-center gap-1 border-b border-border p-2">
        <input
          ref="input"
          v-model="store.query"
          type="text"
          placeholder="Search in files..."
          aria-label="Search in files"
          spellcheck="false"
          role="combobox"
          aria-controls="search-listbox"
          :aria-expanded="listVisible"
          :aria-activedescendant="listVisible ? `search-option-${selectedIndex}` : undefined"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
        <button
          type="button"
          aria-label="Match case"
          title="Match case"
          class="grid size-6 shrink-0 place-items-center rounded-sm font-mono text-xs"
          :class="
            store.isCaseSensitive
              ? 'bg-element-active text-foreground'
              : 'text-foreground-low hover:bg-element-hover'
          "
          @click="store.isCaseSensitive = !store.isCaseSensitive"
        >
          Aa
        </button>
        <button
          type="button"
          aria-label="Match whole word"
          title="Match whole word"
          class="grid size-6 shrink-0 place-items-center rounded-sm font-mono text-xs"
          :class="
            store.isWordMatch
              ? 'bg-element-active text-foreground'
              : 'text-foreground-low hover:bg-element-hover'
          "
          @click="store.isWordMatch = !store.isWordMatch"
        >
          ab
        </button>
        <button
          type="button"
          aria-label="Use regular expression"
          title="Use regular expression"
          class="grid size-6 shrink-0 place-items-center rounded-sm font-mono text-xs"
          :class="
            store.isRegExp
              ? 'bg-element-active text-foreground'
              : 'text-foreground-low hover:bg-element-hover'
          "
          @click="store.isRegExp = !store.isRegExp"
        >
          .*
        </button>
      </div>

      <!-- 不正 regex エラー: 検索 input の直下に赤字表示（VS Code と同じ位置） -->
      <div
        v-if="store.regexError"
        role="alert"
        class="border-b border-border px-3 py-1.5 text-xs text-destructive-text"
      >
        {{ store.regexError }}
      </div>

      <!-- files to include / exclude -->
      <div class="flex flex-col gap-1 border-b border-border p-2">
        <input
          v-model="store.includeText"
          type="text"
          placeholder="files to include (e.g. *.ts, src/)"
          aria-label="Files to include"
          spellcheck="false"
          class="rounded-sm border border-border bg-element px-2 py-1 text-xs text-foreground placeholder:text-foreground-muted focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <input
          v-model="store.excludeText"
          type="text"
          placeholder="files to exclude"
          aria-label="Files to exclude"
          spellcheck="false"
          class="rounded-sm border border-border bg-element px-2 py-1 text-xs text-foreground placeholder:text-foreground-muted focus:ring-2 focus:ring-ring focus:outline-none"
        />
      </div>

      <!-- サマリ -->
      <div
        v-if="statusMessage"
        role="status"
        aria-live="polite"
        class="border-b border-border px-3 py-1.5 text-xs text-foreground-low"
      >
        {{ statusMessage }}
      </div>

      <!-- 結果リスト -->
      <div
        v-if="listVisible"
        id="search-listbox"
        ref="list"
        role="listbox"
        aria-label="Search results"
        class="min-h-0 flex-1 overflow-y-auto py-1 text-xs"
      >
        <template v-for="(row, i) in rows" :key="i">
          <!-- ファイルヘッダー（選択不可） -->
          <div
            v-if="row.kind === 'file'"
            class="truncate px-3 py-1 font-medium text-foreground-low"
            :title="row.path"
          >
            {{ row.path }}
          </div>
          <!-- 行結果（選択可） -->
          <div
            v-else
            :id="`search-option-${i}`"
            role="option"
            :aria-selected="i === selectedIndex"
            class="flex cursor-pointer items-baseline gap-2 px-3 py-0.5 font-mono"
            :class="i === selectedIndex ? 'bg-element-active' : 'hover:bg-element-hover'"
            @click="
              (e) => {
                selectedIndex = i;
                openRow(row, e.metaKey);
              }
            "
          >
            <span class="w-8 shrink-0 text-right text-foreground-muted tabular-nums">
              {{ row.line + 1 }}
            </span>
            <span
              class="min-w-0 flex-1 truncate whitespace-pre"
              :class="row.isContext ? 'text-foreground-muted' : 'text-foreground'"
            >
              <template v-for="(seg, si) in row.segments" :key="si">
                <span v-if="seg.isMatch" class="rounded-xs bg-primary-subtle text-primary-text">{{
                  seg.text
                }}</span>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
          </div>
        </template>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._search-dialog {
  margin: 15vh auto 0;
}

._search-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
