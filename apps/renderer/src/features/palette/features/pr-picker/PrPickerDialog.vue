<doc lang="md">
PR selection dialog. Displays open pull requests in a table layout with fuzzy filtering.

## Behavior

- Opened via `usePrPicker().show()`
- Filters PRs by fuzzy match on title, branch, and author
- Arrow keys navigate rows, Enter accepts, Escape closes
- Draft PRs are dimmed (opacity-50)
- Color scheme follows `gh pr list` (green #number, cyan branch, gray author/date)

## Concurrency

`acceptSelected` calls `close()` before `accept()` so the dialog is removed
from the DOM before the async accept callback (worktree creation) starts.
This is the primary guard against re-entry: callbacks do not need their own
`isCreating` flag because keydown / click events stop reaching the closed
dialog. Additionally, `branch: pr.headRef` is deterministic, so duplicate
creations would be rejected by `git worktree add` itself.
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/proto";
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

const { prItems, viewer, showSignal, accept } = usePrPicker();

const query = ref("");
const filterAssignee = ref(false);
const filterReviewer = ref(false);

/** 検索対象テキストを生成（title, branch, author を結合） */
function searchText(pr: GitPullRequest): string {
  return `#${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`;
}

const filteredPrs = computed((): GitPullRequest[] => {
  const v = viewer.value;
  let items = prItems.value;

  // assignee:me / reviewer:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((pr) => pr.assignees.includes(v));
  }
  if (filterReviewer.value && v !== "") {
    items = items.filter((pr) => pr.reviewers.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ pr: GitPullRequest; score: number }> = [];
  for (const pr of items) {
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
  filterAssignee.value = false;
  filterReviewer.value = false;
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
    <div
      class="w-[960px] overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select a pull request..."
          aria-label="Filter pull requests"
          class="min-w-0 flex-1 rounded-sm bg-transparent px-2 py-1 text-sm text-foreground-strong placeholder:text-foreground-subtle focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs select-none has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterAssignee
              ? 'bg-primary text-primary-foreground'
              : 'bg-surface-2 text-foreground-muted hover:text-foreground-strong'
          "
        >
          <input v-model="filterAssignee" type="checkbox" class="sr-only" />
          assignee:me
        </label>
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs select-none has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterReviewer
              ? 'bg-primary text-primary-foreground'
              : 'bg-surface-2 text-foreground-muted hover:text-foreground-strong'
          "
        >
          <input v-model="filterReviewer" type="checkbox" class="sr-only" />
          reviewer:me
        </label>
      </div>
      <div v-if="filteredPrs.length > 0" ref="list" class="max-h-[400px] overflow-y-auto py-1">
        <div
          v-for="(pr, i) in filteredPrs"
          :key="pr.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 220px 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-surface-2 text-foreground-strong'
              : 'text-foreground hover:bg-accent',
            pr.isDraft && 'opacity-50',
          ]"
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
        >
          <PrPickerRow :pr="pr" />
        </div>
      </div>
      <div v-else class="px-3 py-4 text-center text-sm text-foreground-subtle">
        No matching pull requests
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._pr-picker-dialog {
  margin: 15vh auto 0;
}

._pr-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
