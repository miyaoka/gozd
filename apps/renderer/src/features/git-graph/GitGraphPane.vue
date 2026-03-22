<doc lang="md">
Git commit graph showing the current worktree branch and the default branch.

## Structure

- HTML table for commit data (Description, Date, Author, Commit columns)
- SVG overlay for graph lines and commit dots (Graph column)
- SVG is positioned absolutely over the first column of each row
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/rpc";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { useGitStatusStore, useWorktreeStore } from "../worktree";
import { computeGraphLayout } from "./graphLayout";
import type { GraphLayout } from "./graphLayout";
import { useGitGraphStore } from "./useGitGraphStore";
import { UNCOMMITTED_HASH } from ".";

const { request, onGitStatusChange } = useRpc();
const worktreeStore = useWorktreeStore();
const gitStatusStore = useGitStatusStore();
const gitGraphStore = useGitGraphStore();
const { gitStatuses } = storeToRefs(gitStatusStore);

const commits = ref<GitCommit[]>([]);
const layout = ref<GraphLayout>({ nodes: [], lines: [], maxLanes: 1 });
const firstParentOnly = ref(false);

/** 変更ファイル数 */
const uncommittedChangeCount = computed(() => Object.keys(gitStatuses.value).length);

/**
 * コミット一覧の先頭に Uncommitted Changes 仮想行を挿入する。
 * HEAD コミットを親として接続する。
 */
/** refs 配列に "HEAD" を持つコミットを探す */
function findHeadCommit(rawCommits: GitCommit[]): GitCommit | undefined {
  return rawCommits.find((c) => c.refs.includes("HEAD"));
}

function prependUncommitted(rawCommits: GitCommit[]): GitCommit[] {
  const headCommit = findHeadCommit(rawCommits);
  const headHash = headCommit?.hash ?? "";
  const count = uncommittedChangeCount.value;
  const uncommitted: GitCommit = {
    hash: UNCOMMITTED_HASH,
    shortHash: "*",
    parents: headHash ? [headHash] : [],
    author: "*",
    date: Math.floor(Date.now() / 1000),
    message: `Uncommitted Changes (${count})`,
    refs: [],
  };

  return [uncommitted, ...rawCommits];
}

function recomputeLayout() {
  const withUncommitted = prependUncommitted(commits.value);
  layout.value = computeGraphLayout(withUncommitted, {
    hasUncommitted: true,
  });
}

/** 前回の HEAD ハッシュ。gitStatusChange で変化を検知するために使用 */
let lastHead = "";

async function loadLog() {
  const result = await request.gitLog({
    maxCount: 200,
    firstParentOnly: firstParentOnly.value || undefined,
  });
  commits.value = result;
  lastHead = findHeadCommit(result)?.hash ?? "";
  recomputeLayout();

  // 選択中のコミットが一覧から消えた場合はクリア
  const { selectedHash } = gitGraphStore;
  if (
    selectedHash !== null &&
    selectedHash !== UNCOMMITTED_HASH &&
    !result.some((c) => c.hash === selectedHash)
  ) {
    gitGraphStore.clearSelection();
  }
}

onMounted(loadLog);

// worktree 切り替え時に再取得し、選択をクリア
watch(
  () => worktreeStore.dir,
  () => {
    gitGraphStore.clearSelection();
    void loadLog();
  },
);

// firstParentOnly 切替時に再取得
watch(firstParentOnly, () => {
  gitGraphStore.clearSelection();
  void loadLog();
});

// git status 変更時は uncommitted 行の件数を再計算
watch(uncommittedChangeCount, recomputeLayout);

// HEAD 変更（コミット、リベース等）を検知して git log を再取得する。
// gitStatusChange の payload に含まれる head ハッシュを前回と比較し、
// 変化があった場合のみ git log を再取得する（ファイル保存では走らない）。
const disposeGitStatus = onGitStatusChange(({ head }) => {
  if (head && head !== lastHead) {
    lastHead = head;
    void loadLog();
  }
});
onUnmounted(disposeGitStatus);

/** グラフ描画の定数 */
const LANE_WIDTH = 16;
const ROW_HEIGHT = 24;
const DOT_RADIUS = 4;
const GRAPH_PADDING_X = 12;

/** Graph 列の幅 */
const graphColumnWidth = computed(
  () => GRAPH_PADDING_X + layout.value.maxLanes * LANE_WIDTH + GRAPH_PADDING_X,
);

/** グラフ全体の SVG 高さ */
const svgHeight = computed(() => layout.value.nodes.length * ROW_HEIGHT);

/** レーン番号 → X ピクセル座標 */
function laneX(lane: number): number {
  return GRAPH_PADDING_X + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** 行番号 → Y ピクセル座標（行の中央） */
function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** ブランチの色パレット */
const COLORS = [
  "#4ec9b0", // teal
  "#569cd6", // blue
  "#c586c0", // purple
  "#ce9178", // orange
  "#dcdcaa", // yellow
  "#d16969", // red
  "#608b4e", // green
  "#9cdcfe", // light blue
];

function colorFor(index: number): string {
  return COLORS[index % COLORS.length];
}

/**
 * ラインセグメントの SVG パスを生成する。
 * 各セグメントは隣接する2行間なので、常に1行分の高さ。
 * 同じレーンなら垂直線、異なるレーンならベジェ曲線。
 */
function segmentPath(x1: number, y1: number, x2: number, y2: number): string {
  const px1 = laneX(x1);
  const py1 = rowY(y1);
  const px2 = laneX(x2);
  const py2 = rowY(y2);

  if (px1 === px2) {
    return `M${px1},${py1}L${px2},${py2}`;
  }

  // ベジェ曲線で滑らかにレーン移動
  const d = ROW_HEIGHT * 0.8;
  return `M${px1},${py1}C${px1},${py1 + d} ${px2},${py2 - d} ${px2},${py2}`;
}

function isUncommitted(hash: string): boolean {
  return hash === UNCOMMITTED_HASH;
}

function isMergeCommit(commit: GitCommit): boolean {
  return commit.parents.length > 1;
}

/** ref バッジの色分け */
function refClass(refName: string): string {
  if (refName === "HEAD") return "bg-yellow-600 text-yellow-100";
  if (refName.startsWith("origin/")) return "bg-red-800 text-red-200";
  if (refName.startsWith("tag:")) return "bg-blue-800 text-blue-200";
  return "bg-green-800 text-green-200";
}

/** 日付フォーマット（短い形式） */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = date.toLocaleString("en", { month: "short" });
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

const scrollContainer = ref<HTMLElement | null>(null);

/** 現在選択中のノードのインデックス */
function selectedIndex(): number {
  if (gitGraphStore.selectedHash === null) return -1;
  return layout.value.nodes.findIndex((n) => n.commit.hash === gitGraphStore.selectedHash);
}

/** 選択行をビューポート内にスクロール */
function scrollToIndex(index: number) {
  const container = scrollContainer.value;
  if (!container) return;
  const rowTop = index * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  if (rowTop < container.scrollTop) {
    container.scrollTop = rowTop;
  } else if (rowBottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = rowBottom - container.clientHeight;
  }
}

function onKeydown(e: KeyboardEvent) {
  const nodes = layout.value.nodes;
  if (nodes.length === 0) return;

  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();

  const current = selectedIndex();
  let next: number;

  if (e.key === "ArrowUp") {
    next = current <= 0 ? 0 : current - 1;
  } else {
    next = current >= nodes.length - 1 ? nodes.length - 1 : current + 1;
  }

  if (e.shiftKey) {
    gitGraphStore.selectCompare(nodes[next].commit.hash);
  } else {
    gitGraphStore.select(nodes[next].commit.hash);
  }
  scrollToIndex(next);
}

function onRowClick(hash: string, e: MouseEvent) {
  if (e.shiftKey) {
    gitGraphStore.selectCompare(hash);
  } else {
    gitGraphStore.select(hash);
  }
}

/** 行のハイライトクラスを返す */
function rowHighlightClass(hash: string): string {
  if (hash === gitGraphStore.selectedHash || hash === gitGraphStore.compareHash) {
    return "bg-blue-900/40 hover:bg-blue-900/50";
  }
  if (isInRange(hash)) {
    return "bg-blue-900/20 hover:bg-blue-900/30";
  }
  return "hover:bg-zinc-800/60";
}

/** 2点間の範囲内にあるかどうか */
function isInRange(hash: string): boolean {
  const { selectedHash, compareHash } = gitGraphStore;
  if (selectedHash === null || compareHash === null) return false;
  const nodes = layout.value.nodes;
  const selectedIdx = nodes.findIndex((n) => n.commit.hash === selectedHash);
  const compareIdx = nodes.findIndex((n) => n.commit.hash === compareHash);
  const currentIdx = nodes.findIndex((n) => n.commit.hash === hash);
  if (selectedIdx === -1 || compareIdx === -1 || currentIdx === -1) return false;
  const minIdx = Math.min(selectedIdx, compareIdx);
  const maxIdx = Math.max(selectedIdx, compareIdx);
  return currentIdx > minIdx && currentIdx < maxIdx;
}
</script>

<template>
  <div class="flex size-full flex-col overflow-hidden bg-zinc-900 text-zinc-300 select-none">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-commit-horizontal] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Git Graph</span>
      <span v-if="commits.length > 0" class="text-xs text-zinc-500">({{ commits.length }})</span>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="firstParentOnly ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'"
        @click="firstParentOnly = !firstParentOnly"
      >
        First Parent
      </button>
    </div>

    <div v-if="layout.nodes.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">No commits</div>
    </div>

    <div
      v-else
      ref="scrollContainer"
      class="flex-1 overflow-auto outline-none"
      tabindex="0"
      @keydown="onKeydown"
    >
      <div class="relative" :style="{ minHeight: `${svgHeight}px` }">
        <!-- Graph SVG overlay -->
        <svg
          class="pointer-events-none absolute top-0 left-0"
          :width="graphColumnWidth"
          :height="svgHeight"
        >
          <!-- ラインセグメント -->
          <path
            v-for="(seg, si) in layout.lines"
            :key="`seg-${si}`"
            :d="segmentPath(seg.x1, seg.y1, seg.x2, seg.y2)"
            fill="none"
            :stroke="colorFor(seg.color)"
            stroke-width="2"
            :stroke-dasharray="seg.uncommitted ? '4 2' : undefined"
          />
          <!-- コミットドット -->
          <circle
            v-for="(node, row) in layout.nodes"
            :key="`dot-${node.commit.hash}`"
            :cx="laneX(node.lane)"
            :cy="rowY(row)"
            :r="DOT_RADIUS"
            :fill="isUncommitted(node.commit.hash) ? '#1c1c1c' : colorFor(node.color)"
            :stroke="colorFor(node.color)"
            :stroke-width="isUncommitted(node.commit.hash) ? 2 : 1.5"
          />
        </svg>

        <!-- Commit table rows -->
        <div
          v-for="node in layout.nodes"
          :key="node.commit.hash"
          class="_graph-row flex cursor-pointer items-center text-xs"
          :class="rowHighlightClass(node.commit.hash)"
          :style="{ height: `${ROW_HEIGHT}px` }"
          @click="onRowClick(node.commit.hash, $event)"
        >
          <!-- Graph spacer -->
          <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

          <!-- Description -->
          <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
            <span
              v-if="isMergeCommit(node.commit)"
              class="icon-[lucide--git-merge] size-3.5 shrink-0 text-zinc-500"
            />
            <span
              v-for="ref in node.commit.refs"
              :key="ref"
              class="shrink-0 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium"
              :class="refClass(ref)"
            >
              {{ ref.startsWith("tag:") ? ref.slice(4) : ref }}
            </span>
            <span
              class="truncate"
              :class="isUncommitted(node.commit.hash) ? 'font-semibold text-zinc-400 italic' : ''"
            >
              {{ node.commit.message }}
            </span>
          </div>

          <!-- Date -->
          <div class="w-28 shrink-0 text-zinc-500">
            {{ formatDate(node.commit.date) }}
          </div>

          <!-- Author -->
          <div class="w-28 shrink-0 truncate text-zinc-500">
            {{ node.commit.author }}
          </div>

          <!-- Commit hash -->
          <div class="w-16 shrink-0 font-mono text-zinc-600">
            {{ node.commit.shortHash }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
