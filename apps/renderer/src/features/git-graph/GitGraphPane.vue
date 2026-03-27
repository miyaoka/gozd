<doc lang="md">
Git commit graph showing the current worktree branch and the default branch.

## Structure

- Working Tree row: sticky header outside scroll area, with status icons and dot on lane 0
- Connector line: dashed SVG path from lane 0 top to HEAD lane (straight if same lane, Bézier curve otherwise)
- Scrollable commit list: HTML rows for commit data + SVG overlay for graph lines and dots
- Graph layout reserves lane 0 for the Working Tree connector; commit lanes start from lane 1
- CommitDetailPane is shown as a toggleable right pane inside the graph
- Commits are stored in `useGitGraphStore` and shared with ChangesPane
</doc>

<script setup lang="ts">
import type { GitCommit, GitPullRequest } from "@gozd/rpc";
import { UNCOMMITTED_HASH } from "@gozd/rpc";
import { useElementSize, useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
  watchEffect,
} from "vue";
import { useRpc } from "../../shared/rpc";
import { ResizeHandle } from "../layout";
import { computeStatusIcons, StatusIcons, useGitStatusStore, useWorktreeStore } from "../worktree";
import CommitDetailPane from "./CommitDetailPane.vue";
import type { DisplayRef } from "./displayRef";
import { computeGraphLayout } from "./graphLayout";
import type { GraphLayout } from "./graphLayout";
import { mergeCommitStreams } from "./mergeCommitStreams";
import type { SortMode } from "./mergeCommitStreams";
import RefBadge from "./RefBadge.vue";
import { useGitGraphStore } from "./useGitGraphStore";

const rootRef = useTemplateRef<HTMLElement>("root");
const { width: rootWidth } = useElementSize(rootRef);
const { request, onGitStatusChange, onBranchChange } = useRpc();
const worktreeStore = useWorktreeStore();
const gitStatusStore = useGitStatusStore();
const gitGraphStore = useGitGraphStore();
const { gitStatuses } = storeToRefs(gitStatusStore);

const { commits } = storeToRefs(gitGraphStore);
const defaultBranch = ref<string | undefined>();
const layout = ref<GraphLayout>({ nodes: [], lines: [], maxLanes: 1 });
const firstParentOnly = ref(false);
const sortMode = ref<SortMode>("date");

/** 変更ファイル数 */
const uncommittedChangeCount = computed(() => Object.keys(gitStatuses.value).length);

/** 変更をアイコン付きカウントに変換 */
const statusIcons = computed(() => computeStatusIcons(gitStatuses.value));

/** コミットリスト全体から HEAD が指すカレントブランチ名を取得 */
const currentBranch = computed(() => {
  for (const commit of commits.value) {
    const branch = findCurrentBranch(commit.refs);
    if (branch) return branch;
  }
  return undefined;
});

/**
 * ローカルとリモートが異なるコミットに存在するブランチ名の Set。
 * 同じコミットにローカルとリモートが両方あれば synced（computeDisplayRefs で処理）。
 * 別コミットに分かれていれば out-of-sync としてここで検出する。
 */
const outOfSyncBranches = computed(() => {
  const localCommits = new Map<string, string>();
  const remoteCommits = new Map<string, string>();

  for (const commit of commits.value) {
    for (const r of commit.refs) {
      if (r === "HEAD" || r === "origin/HEAD") continue;
      if (r.startsWith("tag:")) continue;
      if (r.startsWith("origin/")) {
        const name = r.slice("origin/".length);
        remoteCommits.set(name, commit.hash);
      } else {
        localCommits.set(r, commit.hash);
      }
    }
  }

  const result = new Set<string>();
  for (const [name, localHash] of localCommits) {
    const remoteHash = remoteCommits.get(name);
    if (remoteHash && remoteHash !== localHash) {
      result.add(name);
    }
  }
  return result;
});

/** refs 配列に "HEAD" を持つコミットを探す */
function findHeadCommit(rawCommits: GitCommit[]): GitCommit | undefined {
  return rawCommits.find((c) => c.refs.includes("HEAD"));
}

/** Working Tree 接続用に左端 1 レーンを確保 */
const RESERVED_LANES = 1;

function recomputeLayout() {
  layout.value = computeGraphLayout(commits.value, {
    reservedLanes: RESERVED_LANES,
  });
}

/** HEAD ノードのレーン番号。接続線の描画に使用 */
const headLane = computed(() => {
  const node = layout.value.nodes.find((n) => n.commit.refs.includes("HEAD"));
  return node?.lane ?? RESERVED_LANES;
});

/** 前回の HEAD ハッシュ。gitStatusChange で変化を検知するために使用 */
let lastHead = "";
/** 前回の upstream ahead/behind。push/fetch による ref 変化を検知するために使用 */
let lastUpstream = "";
/** loadLog の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadLogGen = 0;

/** @returns 世代チェックを通過して state を更新した場合 true */
async function loadLog(): Promise<boolean> {
  const gen = ++loadLogGen;
  const result = await request.gitLog({
    maxCount: 200,
    firstParentOnly: firstParentOnly.value || undefined,
  });
  if (gen !== loadLogGen) return false;

  const merged = mergeCommitStreams({
    headCommits: result.headCommits,
    defaultBranchCommits: result.defaultBranchCommits,
    sortMode: sortMode.value,
  });

  commits.value = merged;
  defaultBranch.value = result.defaultBranch;
  lastHead = findHeadCommit(merged)?.hash ?? "";
  recomputeLayout();

  // 選択中・比較中のコミットが一覧から消えた場合はクリア
  const { selectedHash, compareHash } = gitGraphStore;
  const isStale = (hash: string | null): boolean =>
    hash !== null && hash !== UNCOMMITTED_HASH && !merged.some((c) => c.hash === hash);

  if (isStale(selectedHash) || isStale(compareHash)) {
    gitGraphStore.resetSelection();
  }
  return true;
}

onMounted(loadLog);

// worktree 切り替え時に再取得し、HEAD にスクロール
watch(
  () => worktreeStore.dir,
  async () => {
    gitGraphStore.resetSelection();
    const updated = await loadLog();
    if (!updated) return;
    await nextTick();
    scrollHeadIntoView();
  },
);

// firstParentOnly / sortMode 切替時に再取得
watch(firstParentOnly, () => {
  gitGraphStore.resetSelection();
  void loadLog();
});
watch(sortMode, () => {
  gitGraphStore.resetSelection();
  void loadLog();
});

// git status 変更時: Working Tree 固定行の件数・アイコンは computed で自動更新されるため watcher 不要

// HEAD 変更（コミット、リベース等）や upstream 変更（push、fetch）を検知して git log を再取得する。
// head ハッシュまたは ahead/behind の変化があった場合のみ再取得する（ファイル保存では走らない）。
const disposeGitStatus = onGitStatusChange(({ head, upstream }) => {
  const upstreamKey = upstream ? `${upstream.ahead}/${upstream.behind}` : "";
  const headChanged = head && head !== lastHead;
  const upstreamChanged = upstreamKey !== lastUpstream;

  if (headChanged) lastHead = head;
  if (upstreamChanged) lastUpstream = upstreamKey;

  if (headChanged || upstreamChanged) {
    void (async () => {
      const updated = await loadLog();
      if (!updated || !headChanged) return;
      await nextTick();
      scrollHeadIntoView();
    })();
  }
  // upstream 変化（push/fetch）時に PR 一覧も再取得
  if (upstreamChanged) {
    void loadPrList();
  }
});
onUnmounted(disposeGitStatus);

// ブランチ ref の変更（作成・削除・リネーム）時に git log を再取得
const disposeBranchChange = onBranchChange(() => {
  void loadLog();
});
onUnmounted(disposeBranchChange);

// --- PR 情報（非同期で後追い取得） ---

/** ブランチ名 → PR のマップ */
const prByBranch = ref(new Map<string, GitPullRequest>());
/** loadPrList の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadPrGen = 0;

/** PR 一覧を取得して prByBranch を更新する。gh 失敗時（null）は前回値を保持する */
async function loadPrList() {
  const gen = ++loadPrGen;
  const prs = await request.gitPrList(undefined);
  if (gen !== loadPrGen) return;
  // gh 失敗時は null — 前回値を保持してバッジが消えるのを防ぐ
  if (!prs) return;
  const map = new Map<string, GitPullRequest>();
  for (const pr of prs) {
    map.set(pr.headRefName, pr);
  }
  prByBranch.value = map;
}

// PR 一覧の定期ポーリング（gh pr create 等でリモートのみ変化するケースに対応）
const PR_POLL_INTERVAL_MS = 60_000;
const { pause: pausePrPoll, resume: resumePrPoll } = useIntervalFn(
  () => void loadPrList(),
  PR_POLL_INTERVAL_MS,
  { immediate: false },
);

onMounted(() => {
  void loadPrList();
  resumePrPoll();
});

// worktree 切り替え時にポーリングをリセット
watch(
  () => worktreeStore.dir,
  () => {
    pausePrPoll();
    void loadPrList();
    resumePrPoll();
  },
);

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

/**
 * Working Tree 固定行 → HEAD コミットへの接続ダッシュ線パス。
 * lane 0 を垂直に降りて、HEAD の1行上からベジェ曲線で HEAD レーンへ合流する。
 * HEAD が row 0 の場合は直接接続する。
 */
const connectorPath = computed(() => {
  const x0 = laneX(0);
  const xHead = laneX(headLane.value);
  const headIndex = layout.value.nodes.findIndex((n) => n.commit.refs.includes("HEAD"));
  if (headIndex === -1) return "";

  const headY = rowY(headIndex);

  // HEAD が lane 0 にいる場合: 垂直直線のみ
  if (x0 === xHead) {
    return `M${x0},0L${x0},${headY}`;
  }

  // lane 0 を垂直に降りて、HEAD の1行上からベジェ曲線で合流。
  // HEAD が row 0 の場合は turnY = 0 となり、垂直部分なしで直接カーブする。
  const turnY = headIndex > 0 ? rowY(headIndex - 1) : 0;
  const span = headY - turnY;
  const d = span * 0.8;
  return `M${x0},0L${x0},${turnY}C${x0},${turnY + d} ${xHead},${headY - d} ${xHead},${headY}`;
});

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

function isMergeCommit(commit: GitCommit): boolean {
  return commit.parents.length > 1;
}

/** HEAD を含むかどうか */
function hasHead(refs: string[]): boolean {
  return refs.includes("HEAD");
}

/**
 * refs 配列から HEAD が指すカレントブランチ名を取得する。
 * git log の %D は "HEAD -> branch" をパース後 ["HEAD", "branch", ...] の順になるため、
 * HEAD の直後の非 origin/非 tag エントリがカレントブランチ。
 */
function findCurrentBranch(refs: string[]): string | undefined {
  const headIdx = refs.indexOf("HEAD");
  if (headIdx === -1) return undefined;
  const next = refs[headIdx + 1];
  if (next && !next.startsWith("origin/") && !next.startsWith("tag:")) {
    return next;
  }
  return undefined;
}

/**
 * refs 配列を表示用に整理する。
 * - HEAD / origin/HEAD は除外（HEAD は → マーカーで別途表示）
 * - origin/xxx とローカル xxx が一致する場合は統合して synced タイプにする
 * - HEAD が指すブランチは current、defaultBranch と一致するブランチは default タイプにする
 */
function computeDisplayRefs(
  refs: string[],
  currentBranchName?: string,
  defaultBranchName?: string,
  outOfSyncSet?: Set<string>,
): DisplayRef[] {
  const filtered = refs.filter((r) => r !== "HEAD" && r !== "origin/HEAD");
  const locals = new Set(filtered.filter((r) => !r.startsWith("origin/") && !r.startsWith("tag:")));
  const remotes = new Set(
    filtered.filter((r) => r.startsWith("origin/")).map((r) => r.slice("origin/".length)),
  );
  const tags = filtered.filter((r) => r.startsWith("tag:"));

  const result: DisplayRef[] = [];

  // ローカルブランチ
  for (const local of locals) {
    const isSynced = remotes.has(local);
    if (isSynced) remotes.delete(local);
    const type = isSynced ? "synced" : "local";
    const isCurrent = local === currentBranchName;
    const isDefault = local === defaultBranchName;
    const isOutOfSync = !isSynced && (outOfSyncSet?.has(local) ?? false);
    result.push({ label: local, type, isSynced, isOutOfSync, isCurrent, isDefault });
  }

  // origin のみ（ローカルに対応がない）
  for (const remote of remotes) {
    const isCurrent = remote === currentBranchName;
    const isDefault = remote === defaultBranchName;
    const isOutOfSync = outOfSyncSet?.has(remote) ?? false;
    result.push({
      label: `origin/${remote}`,
      type: "remote",
      isSynced: false,
      isOutOfSync,
      isCurrent,
      isDefault,
    });
  }

  // タグ
  for (const tag of tags) {
    result.push({
      label: tag.slice("tag:".length),
      type: "tag",
      isSynced: false,
      isOutOfSync: false,
      isCurrent: false,
      isDefault: false,
    });
  }

  return result;
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

/** 詳細ペインの幅 */
const DETAIL_MIN_WIDTH = 200;
const GRAPH_LIST_MIN_WIDTH = 400;
/** ResizeHandle の幅 */
const DETAIL_HANDLE_WIDTH = 8;
const detailWidth = ref(320);
const detailOpen = ref(true);

// コンテナ幅縮小時に detailWidth をクランプし、収まらなければ自動で閉じる
// rootWidth が 0（マウント前）のときはスキップ
watchEffect(() => {
  if (!detailOpen.value || rootWidth.value === 0) return;
  const available = rootWidth.value - GRAPH_LIST_MIN_WIDTH - DETAIL_HANDLE_WIDTH;
  if (available < DETAIL_MIN_WIDTH) {
    detailOpen.value = false;
    return;
  }
  if (detailWidth.value > available) {
    detailWidth.value = Math.max(DETAIL_MIN_WIDTH, available);
  }
});

const graphListRef = ref<HTMLElement | null>(null);
const scrollContainer = ref<HTMLElement | null>(null);

/** 左ペインは flex-1 で自動幅のため、DOM 実測値を返す */
function getGraphListSize(): number {
  const el = scrollContainer.value ?? graphListRef.value;
  return el?.offsetWidth ?? GRAPH_LIST_MIN_WIDTH;
}

/** 現在選択中のノードのインデックス。範囲選択中は compareHash（移動端）を返す */
function selectedIndex(): number {
  const { compareHash } = gitGraphStore;
  const hash = compareHash ?? gitGraphStore.selectedHash;
  return gitGraphStore.hashToIndex.get(hash) ?? -1;
}

/** 選択を Uncommitted Changes に戻し、HEAD コミット付近にスクロール */
function scrollHeadIntoView() {
  const index = layout.value.nodes.findIndex((n) => n.commit.refs.includes("HEAD"));
  if (index === -1) return;
  gitGraphStore.resetSelection();
  scrollToCenter(index);
}

/** 指定行をビューポート中央にスクロール */
function scrollToCenter(index: number) {
  const container = scrollContainer.value;
  if (!container) return;
  const rowCenter = index * ROW_HEIGHT + ROW_HEIGHT / 2;
  container.scrollTop = rowCenter - container.clientHeight / 2;
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

/** ビューポートに収まる行数 */
function pageSize(): number {
  const container = scrollContainer.value;
  if (!container) return 1;
  return Math.max(1, Math.floor(container.clientHeight / ROW_HEIGHT));
}

function onKeydown(e: KeyboardEvent) {
  const nodes = layout.value.nodes;
  if (nodes.length === 0) return;

  const isUp = e.key === "ArrowUp" || e.key === "PageUp";
  const isDown = e.key === "ArrowDown" || e.key === "PageDown";
  if (!isUp && !isDown) return;
  e.preventDefault();

  const isPage = e.key === "PageUp" || e.key === "PageDown";
  const step = isPage ? pageSize() : 1;
  const current = selectedIndex();

  // 移動端が Working Tree にある場合（単一選択 or 範囲選択の compareHash が UNCOMMITTED_HASH）
  if (current === -1) {
    if (isUp) {
      scrollToIndex(0);
      return;
    }
    const next = Math.min(step - 1, nodes.length - 1);
    const hash = nodes[next].commit.hash;
    if (e.shiftKey) {
      gitGraphStore.selectCompare(hash);
    } else {
      gitGraphStore.select(hash);
    }
    scrollToIndex(next);
    return;
  }

  // コミット行先頭付近で上移動 → Working Tree へ
  if (isUp && current !== -1 && current - step < 0) {
    if (e.shiftKey) {
      gitGraphStore.selectCompare(UNCOMMITTED_HASH);
    } else {
      gitGraphStore.select(UNCOMMITTED_HASH);
    }
    return;
  }

  let next: number;

  if (isUp) {
    next = current - step;
  } else {
    next = Math.min(nodes.length - 1, current + step);
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

/**
 * 範囲選択の min/max インデックス。compareHash が null なら undefined。
 * UNCOMMITTED_HASH は layout.nodes に含まれないため -1 として扱う。
 */
const rangeIndices = computed<{ min: number; max: number } | undefined>(() => {
  const { selectedHash, compareHash } = gitGraphStore;
  if (compareHash === null) return undefined;
  const map = gitGraphStore.hashToIndex;
  const selectedIdx = selectedHash === UNCOMMITTED_HASH ? -1 : map.get(selectedHash);
  const compareIdx = compareHash === UNCOMMITTED_HASH ? -1 : map.get(compareHash);
  if (selectedIdx === undefined || compareIdx === undefined) return undefined;
  return { min: Math.min(selectedIdx, compareIdx), max: Math.max(selectedIdx, compareIdx) };
});

/** 2点間の範囲内にあるかどうか */
function isInRange(hash: string): boolean {
  const range = rangeIndices.value;
  if (!range) return false;
  const idx = gitGraphStore.hashToIndex.get(hash);
  if (idx === undefined) return false;
  return idx > range.min && idx < range.max;
}
</script>

<template>
  <div
    ref="root"
    class="flex size-full flex-col overflow-hidden bg-zinc-900 text-zinc-300 select-none"
  >
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
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="
          sortMode === 'topo' ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'
        "
        @click="sortMode = sortMode === 'date' ? 'topo' : 'date'"
      >
        {{ sortMode === "date" ? "Date Order" : "Topo Order" }}
      </button>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
        @click="scrollHeadIntoView"
      >
        Scroll to HEAD
      </button>
      <button
        class="ml-auto rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="detailOpen ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'"
        title="Toggle commit detail"
        aria-label="Toggle commit detail"
        @click="detailOpen = !detailOpen"
      >
        <span class="icon-[lucide--panel-right] size-3.5" />
      </button>
    </div>

    <!-- Graph list + Detail pane (horizontal split) -->
    <div class="flex min-h-0 flex-1">
      <!-- Graph list -->
      <div
        ref="graphListRef"
        class="flex min-w-0 flex-1 flex-col outline-none"
        tabindex="0"
        @keydown="onKeydown"
      >
        <!-- Working Tree 固定行: スクロール領域の外に配置 -->
        <div
          class="_graph-row relative flex shrink-0 items-center border-b border-zinc-700/50 text-xs"
          :class="rowHighlightClass(UNCOMMITTED_HASH)"
          :style="{ height: `${ROW_HEIGHT}px` }"
          @click="onRowClick(UNCOMMITTED_HASH, $event)"
        >
          <!-- Working Tree 行の SVG: lane 0 にドット、下端へダッシュ線 -->
          <svg
            class="pointer-events-none absolute top-0 left-0"
            :width="graphColumnWidth"
            :height="ROW_HEIGHT"
          >
            <circle
              :cx="laneX(0)"
              :cy="ROW_HEIGHT / 2"
              :r="DOT_RADIUS"
              fill="#1c1c1c"
              stroke="#4ec9b0"
              stroke-width="2"
            />
            <line
              :x1="laneX(0)"
              :y1="ROW_HEIGHT / 2 + DOT_RADIUS"
              :x2="laneX(0)"
              :y2="ROW_HEIGHT"
              stroke="#4ec9b0"
              stroke-width="2"
              stroke-dasharray="4 2"
            />
          </svg>

          <!-- Graph spacer -->
          <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

          <!-- Description -->
          <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
            <span
              v-if="uncommittedChangeCount === 0"
              class="truncate font-semibold text-zinc-400 italic"
            >
              Working Tree (Clean)
            </span>
            <StatusIcons v-else :entries="statusIcons" icon-size="size-4" />
          </div>
        </div>

        <!-- スクロール可能なコミットリスト -->
        <div ref="scrollContainer" class="min-h-0 flex-1 overflow-auto">
          <div class="relative" :style="{ minHeight: `${svgHeight}px` }">
            <!-- Graph SVG overlay -->
            <svg
              class="pointer-events-none absolute top-0 left-0"
              :width="graphColumnWidth"
              :height="svgHeight"
            >
              <!-- Working Tree → HEAD 接続ダッシュ線（lane 0 上端から HEAD レーンへ） -->
              <path
                v-if="connectorPath"
                :d="connectorPath"
                fill="none"
                stroke="#4ec9b0"
                stroke-width="2"
                stroke-dasharray="4 2"
              />
              <!-- ラインセグメント -->
              <path
                v-for="(seg, si) in layout.lines"
                :key="`seg-${si}`"
                :d="segmentPath(seg.x1, seg.y1, seg.x2, seg.y2)"
                fill="none"
                :stroke="colorFor(seg.color)"
                stroke-width="2"
              />
              <!-- コミットドット -->
              <circle
                v-for="(node, row) in layout.nodes"
                :key="`dot-${node.commit.hash}`"
                :cx="laneX(node.lane)"
                :cy="rowY(row)"
                :r="DOT_RADIUS"
                fill="currentColor"
                :stroke="colorFor(node.color)"
                stroke-width="1.5"
                class="text-zinc-900"
              />
            </svg>

            <!-- Commit table rows -->
            <div
              v-for="node in layout.nodes"
              :key="node.commit.hash"
              class="_graph-row relative flex items-center text-xs"
              :class="rowHighlightClass(node.commit.hash)"
              :style="{ height: `${ROW_HEIGHT}px` }"
              @click="onRowClick(node.commit.hash, $event)"
            >
              <!-- Graph spacer -->
              <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

              <!-- HEAD marker: グラフ列の右端に absolute 配置。レイアウトに影響しない -->
              <span
                v-if="hasHead(node.commit.refs)"
                class="absolute text-yellow-500"
                :style="{
                  left: `${graphColumnWidth}px`,
                  transform: 'translateX(calc(-100% - 4px))',
                }"
                title="HEAD"
              >
                →
              </span>

              <!-- Description -->
              <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
                <span
                  v-if="isMergeCommit(node.commit)"
                  class="icon-[lucide--git-merge] size-3.5 shrink-0 text-zinc-500"
                />
                <RefBadge
                  v-for="displayRef in computeDisplayRefs(
                    node.commit.refs,
                    currentBranch,
                    defaultBranch,
                    outOfSyncBranches,
                  )"
                  :key="`${displayRef.type}:${displayRef.label}`"
                  :display-ref="displayRef"
                  :pr-by-branch="prByBranch"
                />
                <span class="truncate">
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

      <!-- Detail pane -->
      <template v-if="detailOpen">
        <ResizeHandle
          v-model:after-size="detailWidth"
          direction="horizontal"
          :before-min-size="GRAPH_LIST_MIN_WIDTH"
          :after-min-size="DETAIL_MIN_WIDTH"
          :get-before-size="getGraphListSize"
        />
        <div
          class="shrink-0 overflow-hidden border-l border-zinc-700"
          :style="{ width: `${detailWidth}px` }"
        >
          <CommitDetailPane :commits="gitGraphStore.selectedCommits" />
        </div>
      </template>
    </div>
  </div>
</template>
