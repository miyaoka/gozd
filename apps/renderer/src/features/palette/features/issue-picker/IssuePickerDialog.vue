<doc lang="md">
Issue selection dialog. Displays open issues in a table layout with fuzzy filtering.

## Behavior

- Opens immediately in a loading state, then fills once the gh fetch resolves,
  showing an empty state on 0 results. This gives visible feedback during the gh
  GraphQL wait and when there are no open issues, both of which would otherwise
  look like nothing happened.
- The loading / empty text lives in a single persistent `role="status"` region
  (never `v-if`'d away — only its text is swapped) so screen readers reliably
  announce the state transitions. A live region must pre-exist in the DOM before
  its content changes; a conditionally rendered region inserts container + text
  together, which many screen readers miss.
- Filters issues by fuzzy match on number, title, and author
- Arrow keys navigate rows, Enter accepts, Escape closes
- Color scheme follows `gh issue list` (green #number, gray author/date)
- Rows whose issue already has a task in this repo are tinted (bg-primary-subtle) and
  marked with a check icon; accepting them switches to the existing task's worktree
  instead of creating a new one (the branch decision lives in registerIssueCommand)

## Concurrency

`acceptSelected` calls `close()` before `accept()` so the dialog is removed
from the DOM before the async accept callback (worktree creation) starts.
This is the primary guard against re-entry: callbacks do not need their own
`isCreating` flag because keydown / click events stop reaching the closed
dialog.
</doc>

<script setup lang="ts">
import type { GitIssue } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useListNavigation } from "../../useListNavigation";
import IssuePickerRow from "./IssuePickerRow.vue";
import { useIssuePicker } from "./useIssuePicker";
import type { IssuePickerItem } from "./useIssuePicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: issueItems, viewer, status, showSignal, hideSignal, accept } = useIssuePicker();

const query = ref("");
const filterAssignee = ref(false);

/** 検索対象テキストを生成（number, title, author を結合） */
function searchText(issue: GitIssue): string {
  return `#${issue.number} ${issue.title} ${issue.author}`;
}

const filteredIssues = computed((): IssuePickerItem[] => {
  const v = viewer.value;
  let items = issueItems.value;

  // assignee:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((item) => item.issue.assignees.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ item: IssuePickerItem; score: number }> = [];
  for (const item of items) {
    const result = fuzzyMatch(searchText(item.issue), q);
    if (result) {
      scored.push({ item, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
});

const itemCount = computed(() => filteredIssues.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  issueItems.value.length === 0 ? "No open issues" : "No matching issues",
);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（live region は「先在する
 * region の内容変化」を監視する仕様。同時挿入は取りこぼす）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading issues...";
  if (filteredIssues.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredIssues, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
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

// fetch 失敗時、loading で開いた dialog を閉じる (エラーはコマンド側が toast する)。
watch(hideSignal, () => {
  close();
});

function close() {
  dialogRef.value?.close();
  contextKeys.set("issuePickerVisible", false);
}

function acceptSelected() {
  const item = filteredIssues.value[selectedIndex.value];
  if (!item) return;
  close();
  accept(item);
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
    <div
      class="w-[780px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select an issue..."
          aria-label="Filter issues"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterAssignee
              ? 'bg-primary text-foreground'
              : 'bg-element text-foreground-low hover:text-foreground'
          "
        >
          <input v-model="filterAssignee" type="checkbox" class="sr-only" />
          assignee:me
        </label>
      </div>
      <!--
        常設 status region: DOM から出し入れせずテキストだけ差し替え、loading→empty /
        loading→list の遷移を AT に確実に読ませる。一覧表示中は空要素として残す (高さ 0・不可視)。
        spinner svg は装飾なので aria-hidden で本文だけ読ませる。
      -->
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
        v-if="status === 'ready' && filteredIssues.length > 0"
        ref="list"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(item, i) in filteredIssues"
          :key="item.issue.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-element text-foreground'
              : item.existingTask !== undefined
                ? 'bg-primary-subtle text-foreground hover:bg-primary-subtle-hover'
                : 'text-foreground hover:bg-element-hover',
          ]"
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
        >
          <IssuePickerRow :issue="item.issue" :has-task="item.existingTask !== undefined" />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._issue-picker-dialog {
  margin: 15vh auto 0;
}

._issue-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
