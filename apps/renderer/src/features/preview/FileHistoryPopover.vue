<doc lang="md">
preview ヘッダのコミット日 (FileCommitDate) クリックで開く、ファイル単位の history popover。

開閉とデータ取得は `useFileHistoryPopover` (module singleton) が SSOT。
このコンポーネントは state を購読して描画するだけ。行単位の BlamePopover と並列の別経路で、
blame タブを持たず `git log -- <path>` 一覧だけを出す。

Popover API (`popover="auto"`) の Esc / 外クリック dismiss を `@toggle` で composable の
`close()` に同期させ、anchorEl の付け替えは `openVersion` の watcher 経由で `showPopover` する
(BlamePopover と同一パターン)。MainLayout に 1 度だけ mount する。
</doc>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useGitGraphStore } from "../git-graph";
import CommitHistoryList from "./CommitHistoryList.vue";
import { useFileHistoryPopover } from "./useFileHistoryPopover";
import IconLucideHistory from "~icons/lucide/history";

/**
 * Popover API の `showPopover({ source })` 引数。lib.dom.d.ts に未取り込みなので
 * BlamePopover / SidebarMenu と同じ最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

const popoverRef = ref<PopoverElement>();

const { context, anchorEl, openVersion, historyState, close } = useFileHistoryPopover();
const gitGraphStore = useGitGraphStore();

watch(openVersion, async (v) => {
  if (v === 0) return;
  const el = anchorEl.value;
  if (el === undefined) return;
  await nextTick();
  popoverRef.value?.showPopover({ source: el });
});

function onToggle(event: Event): void {
  if (!(event instanceof ToggleEvent)) return;
  if (event.newState === "closed" && context.value !== undefined) {
    close();
  }
}

function onCommitClick(hash: string): void {
  gitGraphStore.select(hash);
  popoverRef.value?.hidePopover();
}
</script>

<template>
  <div
    ref="popoverRef"
    popover="auto"
    class="m-0 w-104 max-w-[90vw] rounded-lg border border-border bg-background text-sm text-foreground shadow-xl"
    :style="{
      positionArea: 'block-end span-inline-end',
    }"
    @toggle="onToggle"
  >
    <!-- ヘッダー -->
    <div
      class="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground-low"
    >
      <IconLucideHistory class="size-3.5" />
      <span>File history</span>
      <span class="text-foreground-low">·</span>
      <span>{{ context?.modeLabel ?? "" }}</span>
    </div>

    <!-- 本文 -->
    <div class="max-h-[60vh] overflow-auto">
      <div v-if="historyState.kind === 'loading'" class="px-3 py-2 text-xs text-foreground-low">
        Loading history...
      </div>
      <div
        v-else-if="historyState.kind === 'error'"
        class="px-3 py-2 text-xs text-destructive-text"
      >
        {{ historyState.message }}
      </div>
      <div
        v-else-if="historyState.kind === 'ready' && historyState.commits.length === 0"
        class="px-3 py-2 text-xs text-foreground-low"
      >
        No commit history for this file.
      </div>
      <CommitHistoryList
        v-else-if="historyState.kind === 'ready'"
        :commits="historyState.commits"
        @select="onCommitClick"
      />
    </div>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks:
    flip-block,
    flip-inline,
    flip-block flip-inline;
}
</style>
