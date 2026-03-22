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

/** Uncommitted Changes の仮想コミットハッシュ */
const UNCOMMITTED_HASH = "0000000000000000000000000000000000000000";

const { request, onGitStatusChange } = useRpc();
const worktreeStore = useWorktreeStore();
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);

const commits = ref<GitCommit[]>([]);
const layout = ref<GraphLayout>({ nodes: [], lines: [], maxLanes: 1 });

/** git status に変更があるかどうか */
const hasUncommittedChanges = computed(() => Object.keys(gitStatuses.value).length > 0);

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
  if (!hasUncommittedChanges.value) return rawCommits;

  const headCommit = findHeadCommit(rawCommits);
  const headHash = headCommit?.hash ?? "";
  const uncommitted: GitCommit = {
    hash: UNCOMMITTED_HASH,
    shortHash: "*",
    parents: headHash ? [headHash] : [],
    author: "*",
    date: Math.floor(Date.now() / 1000),
    message: `Uncommitted Changes (${uncommittedChangeCount.value})`,
    refs: [],
  };

  return [uncommitted, ...rawCommits];
}

function recomputeLayout() {
  const withUncommitted = prependUncommitted(commits.value);
  layout.value = computeGraphLayout(withUncommitted, {
    hasUncommitted: hasUncommittedChanges.value,
  });
}

/** 前回の HEAD ハッシュ。gitStatusChange で変化を検知するために使用 */
let lastHead = "";

async function loadLog() {
  const result = await request.gitLog({ maxCount: 200 });
  commits.value = result;
  lastHead = findHeadCommit(result)?.hash ?? "";
  recomputeLayout();
}

onMounted(loadLog);

// worktree 切り替え時に再取得
watch(() => worktreeStore.dir, loadLog);

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
</script>

<template>
  <div class="flex size-full flex-col overflow-hidden bg-zinc-900 text-zinc-300">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-commit-horizontal] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Git Graph</span>
      <span v-if="commits.length > 0" class="text-xs text-zinc-500">({{ commits.length }})</span>
    </div>

    <div v-if="layout.nodes.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">No commits</div>
    </div>

    <div v-else class="flex-1 overflow-auto">
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
          class="_graph-row flex items-center text-xs hover:bg-zinc-800/60"
          :style="{ height: `${ROW_HEIGHT}px` }"
        >
          <!-- Graph spacer -->
          <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

          <!-- Description -->
          <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
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
