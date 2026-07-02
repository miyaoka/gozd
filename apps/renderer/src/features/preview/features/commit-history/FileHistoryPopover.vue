<doc lang="md">
preview ヘッダのコミット日 (FileCommitDate) クリックで開く、ファイル単位の history popover。

開閉・データ取得は `useFileHistoryPopover` (module singleton) が SSOT。popover の anchor 付け替えや
light-dismiss は共通抽象 `usePopover` の `Popover` コンポーネントに委譲し、ここは `context` /
`historyState` を購読して描画するだけ。行単位の BlamePopover と並列の別経路で、blame タブを
持たず `git log -- <path>` 一覧だけを出す。MainLayout に 1 度だけ mount する。
</doc>

<script setup lang="ts">
import { useGitGraphStore } from "../../../git-graph";
import CommitHistoryList from "./CommitHistoryList.vue";
import { useFileHistoryPopover } from "./useFileHistoryPopover";
import IconLucideHistory from "~icons/lucide/history";

const { Popover, context, historyState, close } = useFileHistoryPopover();
const gitGraphStore = useGitGraphStore();

function onCommitClick(hash: string): void {
  gitGraphStore.select(hash);
  close();
}
</script>

<template>
  <Popover
    class="m-0 w-104 max-w-[90vw] rounded-lg border border-border bg-background text-sm text-foreground shadow-xl"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <!-- ヘッダー -->
      <div
        class="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground-low"
      >
        <IconLucideHistory class="size-3.5" />
        <span>File history</span>
        <span class="text-foreground-low">·</span>
        <span>{{ context.modeLabel }}</span>
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
    </template>
  </Popover>
</template>
