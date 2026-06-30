<doc lang="md">
行番号クリックで開く blame / history popover。

開閉とデータ取得は `useBlamePopover` (module singleton) が SSOT。popover の anchor 付け替えや
light-dismiss は共通抽象 `usePopover` の `Popover` コンポーネントに委譲し、このコンポーネントは
`context` / `viewMode` / `blameState` / `historyState` を購読して描画するだけ。`open()` の
呼び出し元は PreviewPane / ChangesSummaryItem 等の親側。
</doc>

<script setup lang="ts">
import { formatAbsoluteTime, formatRelativeTime } from "../../shared/time";
import { useGitGraphStore } from "../git-graph";
import CommitHistoryList from "./CommitHistoryList.vue";
import { useBlamePopover } from "./useBlamePopover";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";
import IconLucideHistory from "~icons/lucide/history";

const { Popover, context, viewMode, blameState, historyState, close, setViewMode } =
  useBlamePopover();
const gitGraphStore = useGitGraphStore();

function onCommitClick(hash: string): void {
  gitGraphStore.select(hash);
  close();
}

const HISTORY_DISABLED_TITLE = "History is unavailable for uncommitted lines";

function isHistoryDisabled(): boolean {
  return blameState.value.kind === "ready" && blameState.value.commit.notCommitted;
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
        <IconLucideGitCommitHorizontal class="size-3.5" />
        <span>{{ context.modeLabel }}</span>
        <span class="text-foreground-low">·</span>
        <span>Line {{ context.line }}</span>
        <div class="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            class="px-2 py-0.5 text-xs transition-colors"
            :class="
              viewMode === 'blame'
                ? 'text-primary-text'
                : 'text-foreground-low hover:text-foreground'
            "
            @click="setViewMode('blame')"
          >
            Blame
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-xs transition-colors"
            :class="[
              viewMode === 'history'
                ? 'text-primary-text'
                : 'text-foreground-low hover:text-foreground',
              isHistoryDisabled()
                ? 'cursor-not-allowed text-foreground-muted hover:text-foreground-muted'
                : '',
            ]"
            :disabled="isHistoryDisabled()"
            :title="isHistoryDisabled() ? HISTORY_DISABLED_TITLE : ''"
            @click="setViewMode('history')"
          >
            History
          </button>
        </div>
      </div>

      <!-- 本文 -->
      <div class="max-h-[60vh] overflow-auto">
        <!-- Blame -->
        <template v-if="viewMode === 'blame'">
          <div v-if="blameState.kind === 'loading'" class="px-3 py-2 text-xs text-foreground-low">
            Loading blame...
          </div>
          <div
            v-else-if="blameState.kind === 'error'"
            class="px-3 py-2 text-xs text-destructive-text"
          >
            {{ blameState.message }}
          </div>
          <template v-else-if="blameState.kind === 'ready'">
            <div v-if="blameState.commit.notCommitted" class="p-3 text-xs text-foreground-low">
              Not committed yet (working tree only)
            </div>
            <div v-else class="p-3 text-xs">
              <div class="flex items-center gap-2 text-foreground">
                <span class="rounded-sm bg-panel px-1.5 py-0.5 font-mono text-[11px]">{{
                  blameState.commit.shortHash
                }}</span>
                <span class="truncate" :title="blameState.commit.author">{{
                  blameState.commit.author
                }}</span>
                <span
                  class="ml-auto shrink-0 text-foreground-low"
                  :title="formatAbsoluteTime(Number(blameState.commit.authorTime))"
                >
                  {{ formatRelativeTime(Number(blameState.commit.authorTime)) }}
                </span>
              </div>
              <p class="mt-2 wrap-break-word whitespace-pre-wrap text-foreground">
                {{ blameState.commit.summary }}
              </p>
              <div class="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-sm border border-border px-2 py-1 text-xs text-foreground hover:bg-panel disabled:cursor-not-allowed disabled:border-border-subtle disabled:text-foreground-muted disabled:hover:bg-transparent"
                  :disabled="isHistoryDisabled()"
                  :title="isHistoryDisabled() ? HISTORY_DISABLED_TITLE : ''"
                  @click="setViewMode('history')"
                >
                  <IconLucideHistory class="mr-1 size-3" />
                  View line history
                </button>
                <button
                  type="button"
                  class="rounded-sm border border-border px-2 py-1 text-xs text-foreground hover:bg-panel"
                  @click="onCommitClick(blameState.commit.hash)"
                >
                  <IconLucideGitCommitHorizontal class="mr-1 size-3" />
                  Select in graph
                </button>
              </div>
            </div>
          </template>
        </template>

        <!-- History -->
        <template v-else>
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
            No commits touched this line.
          </div>
          <CommitHistoryList
            v-else-if="historyState.kind === 'ready'"
            :commits="historyState.commits"
            @select="onCommitClick"
          />
        </template>
      </div>
    </template>
  </Popover>
</template>
