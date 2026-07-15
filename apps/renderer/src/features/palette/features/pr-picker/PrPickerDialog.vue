<doc lang="md">
PR selection dialog. Displays open pull requests in a table layout with fuzzy filtering.

## Behavior

- Opens immediately in a loading state, then fills once the gh fetch resolves,
  showing an empty state on 0 results. This gives visible feedback during the gh
  GraphQL wait and when there are no open PRs, both of which would otherwise look
  like nothing happened.
- The loading / empty text lives in a single persistent `role="status"` region
  (never `v-if`'d away — only its text is swapped) so screen readers reliably
  announce the state transitions. A live region must pre-exist in the DOM before
  its content changes; a conditionally rendered region inserts container + text
  together, which many screen readers miss.
- Filters PRs by fuzzy match on title, branch, and author
- Arrow keys navigate rows, Enter accepts, Escape closes
- Draft PRs are dimmed (opacity-50)
- Color scheme follows `gh pr list` (green #number, cyan branch, gray author/date)
- Rows whose PR already has a task in this repo are tinted (bg-primary-subtle) and
  marked with a check icon; accepting them switches to the existing task's worktree
  instead of creating a new one (the branch decision lives in registerPrCommand)
- Shift+Enter / Shift+Click accepts without closing the dialog, for creating
  worktrees from multiple PRs consecutively. The command writes the created task
  back into the picker item on completion, so the row flips to the tinted
  "task exists" state and re-accepting it routes to the existing-task switch

## Concurrency

For a plain accept, `acceptSelected` calls `close()` before `accept()` so the
dialog is removed from the DOM before the async accept callback (worktree
creation) starts; keydown / click events stop reaching the closed dialog.
For a Shift accept the dialog stays open, so that guard does not apply:
accepts of different rows run in parallel, and only re-accepting a row whose
accept is still in flight is blocked (`busyNumbers`) — it would recreate the
same `pr.headRef` branch. Each in-flight row shows a spinner in place of the
check icon.
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
import type { PrPickerItem } from "./usePrPicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: prItems, viewer, status, showSignal, hideSignal, accept } = usePrPicker();

const query = ref("");
const filterAssignee = ref(false);
const filterReviewer = ref(false);
/** Shift 選択 (dialog を閉じない accept) で実行中の PR 番号集合。同一 PR の再 accept
 * (= 同じ headRef branch の二重作成) だけをブロックし、別 PR は並行に accept できる。
 * 実行中の行はチェックマーク位置にスピナーを出す */
const busyNumbers = ref(new Set<number>());

/** 検索対象テキストを生成（title, branch, author を結合） */
function searchText(pr: GitPullRequest): string {
  return `#${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`;
}

const filteredPrs = computed((): PrPickerItem[] => {
  const v = viewer.value;
  let items = prItems.value;

  // assignee:me / reviewer:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((item) => item.pr.assignees.includes(v));
  }
  if (filterReviewer.value && v !== "") {
    items = items.filter((item) => item.pr.reviewers.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ item: PrPickerItem; score: number }> = [];
  for (const item of items) {
    const result = fuzzyMatch(searchText(item.pr), q);
    if (result) {
      scored.push({ item, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
});

const itemCount = computed(() => filteredPrs.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  prItems.value.length === 0 ? "No open pull requests" : "No matching pull requests",
);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（live region は「先在する
 * region の内容変化」を監視する仕様。同時挿入は取りこぼす）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading pull requests...";
  if (filteredPrs.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredPrs, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  filterAssignee.value = false;
  filterReviewer.value = false;
  // 前回 session の Shift 選択が未完了のまま閉じられていても、新 session では
  // 選択をブロックしない (close 後の accept は従来から fire-and-forget)。
  busyNumbers.value.clear();
  reset();
  dialog.showModal();
  contextKeys.set("prPickerVisible", true);
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
  contextKeys.set("prPickerVisible", false);
}

/**
 * keepOpen (Shift 選択) は dialog を閉じずに accept し、連続作成に使う。
 * close() による再入ガードが効かないため、同一 item の accept 実行中だけ再 accept を
 * ブロックする (同じ branch 名での二重作成 = 競合になるため)。別 item は並行に accept できる。
 */
function acceptSelected(keepOpen: boolean) {
  const item = filteredPrs.value[selectedIndex.value];
  if (!item) return;
  if (busyNumbers.value.has(item.pr.number)) return;
  if (!keepOpen) {
    close();
    void accept(item);
    return;
  }
  busyNumbers.value.add(item.pr.number);
  void accept(item).finally(() => {
    busyNumbers.value.delete(item.pr.number);
  });
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
      acceptSelected(e.shiftKey);
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
      class="w-[960px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select a pull request..."
          aria-label="Filter pull requests"
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
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterReviewer
              ? 'bg-primary text-foreground'
              : 'bg-element text-foreground-low hover:text-foreground'
          "
        >
          <input v-model="filterReviewer" type="checkbox" class="sr-only" />
          reviewer:me
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
        v-if="status === 'ready' && filteredPrs.length > 0"
        ref="list"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(item, i) in filteredPrs"
          :key="item.pr.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 220px 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-element text-foreground'
              : item.existingTask !== undefined
                ? 'bg-primary-subtle text-foreground hover:bg-primary-subtle-hover'
                : 'text-foreground hover:bg-element-hover',
            item.pr.isDraft && 'opacity-50',
          ]"
          @click="
            (e) => {
              selectedIndex = i;
              acceptSelected(e.shiftKey);
            }
          "
        >
          <PrPickerRow
            :pr="item.pr"
            :has-task="item.existingTask !== undefined"
            :creating="busyNumbers.has(item.pr.number)"
          />
        </div>
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
