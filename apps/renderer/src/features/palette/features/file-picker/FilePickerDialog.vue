<doc lang="md">
File picker（Go to File）dialog。worktree 内の全ファイルをあいまい検索して preview で開く。

## Behavior

- コマンド側が loading 状態で即時 open し、`git ls-files` の解決後に一覧が埋まる
  （待ち時間の無反応と 0 件時の silent 終了を防ぐ。PR picker と同じ状態機械）
- フィルタは fzf ライクの fuzzy マッチ + スコア降順。描画は上位 100 件で打ち切る
  （filterFiles が SSOT）。ファイル一覧は開くたびに取り直し、開いている間は再取得しない
  （VS Code / orca と同じ「開くたび列挙、監視での無効化はしない」割り切り）
- フィルタは全件をメインスレッドで同期スキャンする設計上限を持つ（debounce / worker /
  事前 index なし）。数万ファイル規模で入力が引っかかる場合はここが再検討ポイント
- Arrow keys navigate, Enter accepts, Escape closes
- 選択で `usePreviewStore().forceSelect`（同一 path でも必ず開く）

## Accessibility

- loading / empty のテキストは常設 `role="status"` region の差し替えで通知する
  （PrPickerDialog と同じ理由: live region は先在が前提）
- WAI-ARIA combobox パターン: input が `role="combobox"` + `aria-activedescendant` で
  選択行を指し、リストは `listbox` / `option` + `aria-selected`。フォーカスを input に
  留めたまま矢印移動を SR に読ませるための配線
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { useListNavigation } from "../../useListNavigation";
import FilePickerRow from "./FilePickerRow.vue";
import { filterFiles } from "./filterFiles";
import { useFilePicker } from "./useFilePicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: files, status, showSignal, hideSignal, accept } = useFilePicker();

const query = ref("");

const filteredFiles = computed((): string[] => filterFiles(files.value, query.value));

const itemCount = computed(() => filteredFiles.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  files.value.length === 0 ? "No files found" : "No matching files",
);

const listVisible = computed(() => status.value === "ready" && filteredFiles.value.length > 0);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移を
 * 確実に読み上げる（PrPickerDialog と同じ規律）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading files...";
  if (filteredFiles.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredFiles, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  reset();
  dialog.showModal();
  contextKeys.set("filePickerVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

// fetch 失敗時、loading で開いた dialog を閉じる (エラーはコマンド側が toast する)。
watch(hideSignal, () => {
  close();
});

function close() {
  dialogRef.value?.close();
  contextKeys.set("filePickerVisible", false);
}

function acceptSelected() {
  const path = filteredFiles.value[selectedIndex.value];
  if (path === undefined) return;
  close();
  accept(path);
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
    class="_file-picker-dialog"
    aria-label="Go to file"
    @keydown="handleKeydown"
    @close="contextKeys.set('filePickerVisible', false)"
  >
    <div
      class="w-[640px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Search files by name..."
          aria-label="Search files"
          role="combobox"
          aria-controls="file-picker-listbox"
          :aria-expanded="listVisible"
          :aria-activedescendant="listVisible ? `file-picker-option-${selectedIndex}` : undefined"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :class="
          statusMessage
            ? 'flex items-center justify-center gap-2 px-3 py-8 text-sm text-foreground-low'
            : ''
        "
      >
        <IconLucideLoaderCircle
          v-if="status === 'loading'"
          aria-hidden="true"
          class="size-4 animate-spin"
        />
        {{ statusMessage }}
      </div>
      <div
        v-if="listVisible"
        id="file-picker-listbox"
        ref="list"
        role="listbox"
        aria-label="Files"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(path, i) in filteredFiles"
          :key="path"
          :id="`file-picker-option-${i}`"
          role="option"
          :aria-selected="i === selectedIndex"
          class="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm"
          :class="
            i === selectedIndex
              ? 'bg-element-active text-foreground'
              : 'text-foreground hover:bg-element-hover'
          "
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
        >
          <FilePickerRow :path="path" />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._file-picker-dialog {
  margin: 15vh auto 0;
}

._file-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
