<doc lang="md">
worktree 内のファイルを名前で探して開くダイアログ。

一覧の取得を待たずに開き、解決したら中身を差し替える。取得結果が 0 件のときも空であることを
明示する。完了まで何も出さないと、待ちと「コマンドが効かなかった」が区別できない。

## 一覧は開くたびに取り直す

開いている間の変更は追わない。ファイルの増減を監視して一覧を無効化する仕組みは持たず、次に開いた
ときに取り直すことで整合させる。**ファイルの一覧は選ぶ瞬間だけ必要**で、開いたまま眺め続ける
ものではないため、監視の維持費に見合わない。

## 絞り込みは全件を一度に走査する

入力のたびに全件を同期で走査し、間引きも事前索引も持たない。ここが規模の上限を決める設計判断で、
数万ファイル規模で入力が詰まるならこの前提から見直すことになる。

描画は上位の一定件数で打ち切る。候補が数千件あっても、名前で探している以上、絞り込みを続ける
ほうが下へスクロールするより速く目的に着く。

## 開き方

選ぶと、同じファイルが既に選択されていても必ず開き直す。ここは「そのファイルを見に行く」ための
入口なので、選んだのに何も起きない状態を作らない。
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
  void accept(path);
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
