<doc lang="md">
PR selection dialog. Displays open pull requests in a table layout with fuzzy filtering.

## Behavior

- Opened via `usePrPicker().show()`
- Filters PRs by fuzzy match on title, branch, and author
- Arrow keys navigate rows, Enter accepts, Escape closes
- Draft PRs are dimmed (opacity-50)
- Color scheme follows `gh pr list` (green #number, cyan branch, gray author/date)
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useListNavigation } from "../../useListNavigation";
import PrPickerRow from "./PrPickerRow.vue";
import { usePrPicker } from "./usePrPicker";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { prItems, showSignal, accept } = usePrPicker();

const query = ref("");

/** 検索対象テキストを生成（title, branch, author を結合） */
function searchText(pr: GitPullRequest): string {
  return `#${pr.number} ${pr.title} ${pr.headRefName} ${pr.author}`;
}

const filteredPrs = computed((): GitPullRequest[] => {
  const q = query.value;
  if (q === "") return prItems.value;

  const scored: Array<{ pr: GitPullRequest; score: number }> = [];
  for (const pr of prItems.value) {
    const result = fuzzyMatch(searchText(pr), q);
    if (result) {
      scored.push({ pr, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.pr);
});

const itemCount = computed(() => filteredPrs.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

watch(filteredPrs, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  if (prItems.value.length === 0) return;
  query.value = "";
  reset();
  dialog.showModal();
  contextKeys.set("prPickerVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

function close() {
  dialogRef.value?.close();
  contextKeys.set("prPickerVisible", false);
}

function acceptSelected() {
  const pr = filteredPrs.value[selectedIndex.value];
  if (!pr) return;
  close();
  accept(pr);
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
    class="_pr-picker-dialog"
    aria-label="Pull request picker"
    @keydown="handleKeydown"
    @close="contextKeys.set('prPickerVisible', false)"
  >
    <div class="w-[960px] overflow-hidden rounded-lg border border-zinc-600 bg-zinc-800 shadow-2xl">
      <div class="border-b border-zinc-700 p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select a pull request..."
          aria-label="Filter pull requests"
          class="w-full bg-transparent px-2 py-1 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
        />
      </div>
      <div v-if="filteredPrs.length > 0" ref="list" class="max-h-[400px] overflow-y-auto py-1">
        <div
          v-for="(pr, i) in filteredPrs"
          :key="pr.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 220px 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-300 hover:bg-zinc-700/50',
            pr.isDraft && 'opacity-50',
          ]"
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
          @pointerenter="selectedIndex = i"
        >
          <PrPickerRow :pr="pr" />
        </div>
      </div>
      <div v-else class="px-3 py-4 text-center text-sm text-zinc-500">
        No matching pull requests
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._pr-picker-dialog {
  padding: 0;
  border: none;
  background: transparent;
  margin: 15vh auto 0;
}

._pr-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
