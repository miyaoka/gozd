<doc lang="md">
Issue selection dialog. Displays open issues in a table layout with fuzzy filtering.

## Behavior

- Opened via `useIssuePicker().show()`
- Filters issues by fuzzy match on number, title, and author
- Arrow keys navigate rows, Enter accepts, Escape closes
- Color scheme follows `gh issue list` (green #number, gray author/date)
</doc>

<script setup lang="ts">
import type { GitIssue } from "@gozd/proto";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useListNavigation } from "../../useListNavigation";
import IssuePickerRow from "./IssuePickerRow.vue";
import { useIssuePicker } from "./useIssuePicker";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { issueItems, viewer, showSignal, accept } = useIssuePicker();

const query = ref("");
const filterAssignee = ref(false);

/** 検索対象テキストを生成（number, title, author を結合） */
function searchText(issue: GitIssue): string {
  return `#${issue.number} ${issue.title} ${issue.author}`;
}

const filteredIssues = computed((): GitIssue[] => {
  const v = viewer.value;
  let items = issueItems.value;

  // assignee:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((issue) => issue.assignees.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ issue: GitIssue; score: number }> = [];
  for (const issue of items) {
    const result = fuzzyMatch(searchText(issue), q);
    if (result) {
      scored.push({ issue, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.issue);
});

const itemCount = computed(() => filteredIssues.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

watch(filteredIssues, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  if (issueItems.value.length === 0) return;
  query.value = "";
  filterAssignee.value = false;
  reset();
  dialog.showModal();
  contextKeys.set("issuePickerVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

function close() {
  dialogRef.value?.close();
  contextKeys.set("issuePickerVisible", false);
}

function acceptSelected() {
  const issue = filteredIssues.value[selectedIndex.value];
  if (!issue) return;
  close();
  accept(issue);
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
    class="_issue-picker-dialog"
    aria-label="Issue picker"
    @keydown="handleKeydown"
    @close="contextKeys.set('issuePickerVisible', false)"
  >
    <div class="w-[780px] overflow-hidden rounded-lg border border-zinc-600 bg-zinc-800 shadow-2xl">
      <div class="flex items-center gap-2 border-b border-zinc-700 p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select an issue..."
          aria-label="Filter issues"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
        />
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs select-none has-focus-visible:ring-2 has-focus-visible:ring-blue-400"
          :class="
            filterAssignee
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-700 text-zinc-400 hover:text-zinc-200'
          "
        >
          <input v-model="filterAssignee" type="checkbox" class="sr-only" />
          assignee:me
        </label>
      </div>
      <div v-if="filteredIssues.length > 0" ref="list" class="max-h-[400px] overflow-y-auto py-1">
        <div
          v-for="(issue, i) in filteredIssues"
          :key="issue.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-300 hover:bg-zinc-700/50',
          ]"
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
        >
          <IssuePickerRow :issue="issue" />
        </div>
      </div>
      <div v-else class="px-3 py-4 text-center text-sm text-zinc-500">No matching issues</div>
    </div>
  </dialog>
</template>

<style scoped>
._issue-picker-dialog {
  padding: 0;
  border: none;
  background: transparent;
  margin: 15vh auto 0;
}

._issue-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
