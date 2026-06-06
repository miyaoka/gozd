<doc lang="md">
行番号クリックで開く blame / history popover。

開閉とデータ取得は `useBlamePopover` (module singleton) が SSOT。
このコンポーネントは state を購読して描画するだけで、`open()` の呼び出し元は
PreviewPane / ChangesSummaryItem 等の親側。

Popover API (`popover="auto"`) の Esc / 外クリック dismiss を `@toggle` で
受けて composable の `close()` に同期させ、anchorEl の付け替えは
`openVersion` の watcher 経由で `showPopover({ source })` を呼ぶ。
</doc>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { formatAbsoluteTime, formatRelativeTime } from "../../shared/time";
import { useGitGraphStore } from "../git-graph";
import { useBlamePopover } from "./useBlamePopover";

/**
 * Popover API の `showPopover({ source })` 引数。lib.dom.d.ts に未取り込みなので
 * SidebarMenu と同じ最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

const popoverRef = ref<PopoverElement>();

const { context, anchorEl, openVersion, viewMode, blameState, historyState, close, setViewMode } =
  useBlamePopover();
const gitGraphStore = useGitGraphStore();

/**
 * open のたびにインクリメントされる `openVersion` を見て、ブラウザに
 * `showPopover({ source })` を発火させる。同じ anchor で再 open しても version が
 * 変わるので確実にイベントが届く。
 */
watch(openVersion, async (v) => {
  if (v === 0) return;
  const el = anchorEl.value;
  if (el === undefined) return;
  await nextTick();
  popoverRef.value?.showPopover({ source: el });
});

/**
 * Popover API は Esc / 外クリック / 親 popover の close 連動で勝手に閉じうる。
 * その際は composable 側の state も同期して clear する (進行中 RPC を破棄)。
 */
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

const HISTORY_DISABLED_TITLE = "History is unavailable for uncommitted lines";

function isHistoryDisabled(): boolean {
  return blameState.value.kind === "ready" && blameState.value.commit.notCommitted;
}
</script>

<template>
  <div
    ref="popoverRef"
    popover="auto"
    class="m-0 w-104 max-w-[90vw] rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 shadow-xl"
    :style="{
      positionArea: 'block-end span-inline-end',
    }"
    @toggle="onToggle"
  >
    <!-- ヘッダー -->
    <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2 text-xs text-zinc-400">
      <span class="icon-[lucide--git-commit-horizontal] size-3.5" />
      <span>{{ context?.modeLabel ?? "" }}</span>
      <span class="text-zinc-600">·</span>
      <span>Line {{ context?.line ?? "" }}</span>
      <div class="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          class="px-2 py-0.5 text-xs transition-colors"
          :class="viewMode === 'blame' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
          @click="setViewMode('blame')"
        >
          Blame
        </button>
        <button
          type="button"
          class="px-2 py-0.5 text-xs transition-colors"
          :class="[
            viewMode === 'history' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300',
            isHistoryDisabled() ? 'cursor-not-allowed opacity-40' : '',
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
        <div v-if="blameState.kind === 'loading'" class="px-3 py-2 text-xs text-zinc-500">
          Loading blame...
        </div>
        <div v-else-if="blameState.kind === 'error'" class="px-3 py-2 text-xs text-red-400">
          {{ blameState.message }}
        </div>
        <template v-else-if="blameState.kind === 'ready'">
          <div v-if="blameState.commit.notCommitted" class="p-3 text-xs text-zinc-400">
            Not committed yet (working tree only)
          </div>
          <div v-else class="p-3 text-xs">
            <div class="flex items-center gap-2 text-zinc-300">
              <span class="rounded-sm bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px]">{{
                blameState.commit.shortHash
              }}</span>
              <span class="truncate" :title="blameState.commit.author">{{
                blameState.commit.author
              }}</span>
              <span
                class="ml-auto shrink-0 text-zinc-500"
                :title="formatAbsoluteTime(Number(blameState.commit.authorTime))"
              >
                {{ formatRelativeTime(Number(blameState.commit.authorTime)) }}
              </span>
            </div>
            <p class="mt-2 wrap-break-word whitespace-pre-wrap text-zinc-200">
              {{ blameState.commit.summary }}
            </p>
            <div class="mt-3 flex items-center gap-2">
              <button
                type="button"
                class="rounded-sm border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="isHistoryDisabled()"
                :title="isHistoryDisabled() ? HISTORY_DISABLED_TITLE : ''"
                @click="setViewMode('history')"
              >
                <span class="mr-1 icon-[lucide--history] size-3" />
                View line history
              </button>
              <button
                type="button"
                class="rounded-sm border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                @click="onCommitClick(blameState.commit.hash)"
              >
                <span class="mr-1 icon-[lucide--git-commit-horizontal] size-3" />
                Select in graph
              </button>
            </div>
          </div>
        </template>
      </template>

      <!-- History -->
      <template v-else>
        <div v-if="historyState.kind === 'loading'" class="px-3 py-2 text-xs text-zinc-500">
          Loading history...
        </div>
        <div v-else-if="historyState.kind === 'error'" class="px-3 py-2 text-xs text-red-400">
          {{ historyState.message }}
        </div>
        <div
          v-else-if="historyState.kind === 'ready' && historyState.commits.length === 0"
          class="px-3 py-2 text-xs text-zinc-500"
        >
          No commits touched this line.
        </div>
        <ul v-else-if="historyState.kind === 'ready'" class="divide-y divide-zinc-800">
          <li v-for="c in historyState.commits" :key="c.hash">
            <button
              type="button"
              class="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-800"
              @click="onCommitClick(c.hash)"
            >
              <span
                class="mt-0.5 shrink-0 rounded-sm bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
                >{{ c.shortHash }}</span
              >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-zinc-200">{{ c.message }}</span>
                <span class="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span class="truncate">{{ c.author }}</span>
                  <span :title="formatAbsoluteTime(Number(c.date))">{{
                    formatRelativeTime(Number(c.date))
                  }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
      </template>
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
