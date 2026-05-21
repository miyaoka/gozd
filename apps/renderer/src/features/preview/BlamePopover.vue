<doc lang="md">
行番号クリックで開く blame popover。

`openPopover(anchorEl, ctx)` で SidebarMenu と同じく Popover API の implicit anchor を
使って行番号要素の右下に出す。`popover="auto"` で Esc / 外クリックの dismiss は
ブラウザに委譲する。

## 2 ステート

- `blame` (初期): クリックされた 1 行の blame 結果を表示。`source_line` を起点に
  history を取りに行ける
- `history`: `git log -L<line>,<line>:<file>` 相当の commit 一覧を表示。
  クリックで git-graph store の `select(hash)` を呼んで popover を閉じる

`source_line` を起点にするのは blame が「現在の表示行 → 元 commit の行番号」を
返してくれるため。表示中ファイル (working tree / 任意 rev) で行が後から挿入された
影響を吸収して、history walk が中断されないようにする。
</doc>

<script setup lang="ts">
import type { GitBlameCommit, GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { nextTick, ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useGitGraphStore } from "../git-graph";
import { rpcGitBlameLine, rpcGitLogLine } from "./rpc";

/**
 * Popover API の `showPopover({ source })` 引数。lib.dom.d.ts に未取り込みなので
 * SidebarMenu と同じ最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

type PopoverContext = {
  dir: string;
  relPath: string;
  /** "" = working tree, "HEAD" / <hash> / "<hash>^" など */
  rev: string;
  /** 1-based、表示中のテキスト上の行番号 */
  line: number;
  /** Original / Current などモード表記。header の補助情報として表示する */
  modeLabel: string;
};

type ViewMode = "blame" | "history";

type BlameState =
  | { kind: "loading" }
  | { kind: "ready"; commit: GitBlameCommit }
  | { kind: "error"; message: string };

type HistoryState =
  | { kind: "loading" }
  | { kind: "ready"; commits: GitCommit[] }
  | { kind: "error"; message: string };

const notification = useNotificationStore();
const gitGraphStore = useGitGraphStore();

const popoverRef = ref<PopoverElement>();
const context = ref<PopoverContext>();
const viewMode = ref<ViewMode>("blame");
const blameState = ref<BlameState>({ kind: "loading" });
const historyState = ref<HistoryState>({ kind: "loading" });

/** 重複 RPC 抑止。新規 open のたびにインクリメントし、await 復帰時に変わっていたら破棄 */
let loadVersion = 0;

const HISTORY_MAX = 100;

/** popover を anchorEl の下に表示し、blame を fetch する */
async function openPopover(anchorEl: HTMLElement, ctx: PopoverContext): Promise<void> {
  context.value = ctx;
  viewMode.value = "blame";
  blameState.value = { kind: "loading" };
  historyState.value = { kind: "loading" };
  const version = ++loadVersion;
  await nextTick();
  popoverRef.value?.showPopover({ source: anchorEl });

  const result = await tryCatch(
    rpcGitBlameLine({ dir: ctx.dir, relPath: ctx.relPath, rev: ctx.rev, line: ctx.line }),
  );
  if (version !== loadVersion) return;
  if (!result.ok) {
    blameState.value = { kind: "error", message: result.error.message };
    notification.error("Failed to blame line", result.error);
    return;
  }
  const commit = result.value.commit;
  if (commit === undefined) {
    blameState.value = { kind: "error", message: "blame response had no commit" };
    return;
  }
  blameState.value = { kind: "ready", commit };
}

function closePopover(): void {
  popoverRef.value?.hidePopover();
}

/** 表示中のファイル状態に合わせた起点で history (log -L) を取得する */
async function loadHistory(): Promise<void> {
  const ctx = context.value;
  if (ctx === undefined) return;
  // blame が source_line を返していればそれを history 起点に使う (rev の元行番号)。
  // 取れていない場合 (blame loading / error) は表示中の line をそのまま使う fallback。
  const blame = blameState.value;
  const startLine =
    blame.kind === "ready" && blame.commit.sourceLine > 0 ? blame.commit.sourceLine : ctx.line;
  // blame が working tree (rev="") の hash を返している場合は rev に hash を渡すと
  // 「未来 commit から walk」になり結果が空になる。rev を空に倒すと HEAD 起点で走る。
  // 表示が rev 指定 (Original 等) の場合はその rev のままで OK。
  const rev = ctx.rev;
  historyState.value = { kind: "loading" };
  const version = ++loadVersion;
  const result = await tryCatch(
    rpcGitLogLine({
      dir: ctx.dir,
      relPath: ctx.relPath,
      rev,
      line: startLine,
      maxCount: HISTORY_MAX,
    }),
  );
  if (version !== loadVersion) return;
  if (!result.ok) {
    historyState.value = { kind: "error", message: result.error.message };
    notification.error("Failed to load line history", result.error);
    return;
  }
  historyState.value = { kind: "ready", commits: result.value.commits };
}

async function switchToHistory(): Promise<void> {
  viewMode.value = "history";
  if (historyState.value.kind === "loading" || historyState.value.kind === "error") {
    await loadHistory();
  }
}

function switchToBlame(): void {
  viewMode.value = "blame";
}

function onCommitClick(hash: string): void {
  gitGraphStore.select(hash);
  closePopover();
}

/** Unix 秒 → 人間が読みやすい相対時刻文字列 */
function relativeTime(unixSec: number): string {
  if (unixSec <= 0) return "";
  const diffSec = Math.floor(Date.now() / 1000) - unixSec;
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / 86400 / 30)}mo ago`;
  return `${Math.floor(diffSec / 86400 / 365)}y ago`;
}

function absoluteTime(unixSec: number): string {
  if (unixSec <= 0) return "";
  const d = new Date(unixSec * 1000);
  return d.toLocaleString();
}

defineExpose({ openPopover });
</script>

<template>
  <div
    ref="popoverRef"
    popover="auto"
    class="m-0 w-104 max-w-[90vw] rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 shadow-xl"
    :style="{
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
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
          @click="switchToBlame"
        >
          Blame
        </button>
        <button
          type="button"
          class="px-2 py-0.5 text-xs transition-colors"
          :class="viewMode === 'history' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
          @click="switchToHistory"
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
        <template v-else>
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
                :title="absoluteTime(Number(blameState.commit.authorTime))"
              >
                {{ relativeTime(Number(blameState.commit.authorTime)) }}
              </span>
            </div>
            <p class="mt-2 wrap-break-word whitespace-pre-wrap text-zinc-200">
              {{ blameState.commit.summary }}
            </p>
            <div class="mt-3 flex items-center gap-2">
              <button
                type="button"
                class="rounded-sm border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                @click="switchToHistory"
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
        <div v-else-if="historyState.commits.length === 0" class="px-3 py-2 text-xs text-zinc-500">
          No commits touched this line.
        </div>
        <ul v-else class="divide-y divide-zinc-800">
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
                  <span :title="absoluteTime(Number(c.date))">{{
                    relativeTime(Number(c.date))
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
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
