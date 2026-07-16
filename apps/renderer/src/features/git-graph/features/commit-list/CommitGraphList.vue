<doc lang="md">
commit graph 本体。commits からレーンレイアウトを算出し、Working Tree 行・SVG overlay・commit 行を
組み合わせて描く。キーボードナビ・スクロール・行クリック選択を担う。

## layout は行と SVG の共有 spine

行の v-for と SVG の dot は同じ layout を辿り、同じ行高で重なる。これで gap 行挿入を含め dot と行が
常に整合する。片方だけに layout を持たせず 1 つを両方へ配る。

## 列の縦揃えは subgrid で共有する

Working Tree 行 (sticky) と commit 行を 1 枚の master grid の直接の子として並べ、各行は
`grid-template-columns: subgrid` で master のトラックを共有する。共有トラックは全行のセル内容を
合算して解決されるため、date/hash を content 幅 (max-content) にしても行間で列がズレない。
別 grid ごとに `--graph-cols` を各自解決させると content 依存幅が行ごとにバラつくため subgrid で束ねる。

## HEAD スクロール

data 取得側 (親) が出す scroll 要求 signal を watch して実スクロールする。DOM 反映後に走らせるため
flush: "post"。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { useElementSize, useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import { computeStatusIcons, UNCOMMITTED_HASH, useGitStatusStore } from "../../../worktree";
import { linkifyCommitMessage } from "../../linkifyCommitMessage";
import { useGitGraphStore } from "../../useGitGraphStore";
import CommitRow from "./CommitRow.vue";
import GapRow from "./GapRow.vue";
import { ROW_HEIGHT, graphColumnWidth as calcGraphColumnWidth } from "./graphGeometry";
import { computeGraphLayout } from "./graphLayout";
import { computeOutOfSyncBranches } from "./graphRefs";
import GraphSvgOverlay from "./GraphSvgOverlay.vue";
import WorkingTreeRow from "./WorkingTreeRow.vue";
import IconLucideArrowDown from "~icons/lucide/arrow-down";
import IconLucideArrowUp from "~icons/lucide/arrow-up";

const props = defineProps<{
  /** デフォルトブランチ名 (ref を default タイプに分類する)。loadLog 結果由来で親が渡す */
  defaultBranch?: string;
  /** GitHub repo base URL (コミットメッセージ `#N` リンク化)。親が repo identity から導出 */
  issueLinkBaseUrl?: string;
  /** ブランチ名 → PR のマップ。親が prListStore から渡す */
  prByBranch: Map<string, GitPullRequest>;
}>();

const emit = defineEmits<{
  commitContextmenu: [payload: { hash: string; anchorEl: HTMLElement; x: number; y: number }];
}>();

const gitGraphStore = useGitGraphStore();
const gitStatusStore = useGitStatusStore();
const { commits } = storeToRefs(gitGraphStore);
const { gitStatuses, workingTreeMtime } = storeToRefs(gitStatusStore);

/** commits + HEAD からレーンレイアウトを算出。commits 変化で自動再計算する。 */
const layout = computed(() =>
  computeGraphLayout(commits.value, { headHash: gitGraphStore.headHash }),
);

/** 変更ファイル数 (Working Tree 行) */
const uncommittedChangeCount = computed(() => Object.keys(gitStatuses.value).length);
/** 変更をアイコン付きカウントに変換 (Working Tree 行) */
const statusIcons = computed(() => computeStatusIcons(gitStatuses.value));

/** HEAD が指すカレントブランチ名 (ref を current タイプに分類する) */
const currentBranch = computed(() => gitGraphStore.currentBranch);

/** ローカルとリモートが別コミットに分かれているブランチ名の集合 */
const outOfSyncBranches = computed(() => computeOutOfSyncBranches(commits.value));

/**
 * refs に "HEAD" を持つ表示中ノードとその行番号。Working Tree 行の色・HEAD スクロールの導出元。
 */
const headNode = computed(() => {
  const index = layout.value.nodes.findIndex((n) => n.commit.refs.includes("HEAD"));
  if (index === -1) return undefined;
  return { node: layout.value.nodes[index], index };
});

/** HEAD ノードの色インデックス。Working Tree のドット/接続線を HEAD と同色に揃える。不在時 0。 */
const headColor = computed(() => headNode.value?.node.color ?? 0);

/** Graph 列の幅。右側は最右レーンの dot 用のガターを確保する。 */
const graphColumnWidth = computed(() => calcGraphColumnWidth(layout.value.maxLanes));

/** commit message (col 2) の最低幅。これを下回るまでは date/author/hash (min 0) が先に潰れ、
 *  message はここまで幅を保つ (狭幅時に message が真っ先に潰れるのを防ぐ)。 */
const MIN_MESSAGE_WIDTH = "12rem";

/**
 * master grid の列トラック SSOT (subgrid 共有でこれを全行が引く。共有の理由は <doc> 参照)。
 * col1 graph = 動的 px、col2 message = 最低幅つき 1fr、date/hash = 内容幅 (max-content)、
 * author = 内容依存だと長い名前で膨らむため 7rem cap。狭幅では min 0 の date/hash が先に truncate する。
 */
const graphCols = computed(
  () =>
    `${graphColumnWidth.value}px minmax(${MIN_MESSAGE_WIDTH}, 1fr) minmax(0, max-content) minmax(0, 7rem) minmax(0, max-content)`,
);

/** グラフ全体の高さ (行数 × 行高)。scroll 領域の minHeight に使う。 */
const svgHeight = computed(() => layout.value.nodes.length * ROW_HEIGHT);

/** 表示中の各 commit の subject を linkify した segments を hash で引ける map。
 * template から関数呼び出しすると毎 render で全 commit 分 matchAll が走るため computed に閉じる。 */
const commitMessageSegmentsByHash = computed(() => {
  const baseUrl = props.issueLinkBaseUrl;
  const map = new Map<string, ReturnType<typeof linkifyCommitMessage>>();
  for (const node of layout.value.nodes) {
    map.set(node.commit.hash, linkifyCommitMessage(node.commit.message, baseUrl));
  }
  return map;
});

// --- スクロール / キーボードナビ ---

const scrollContainer = ref<HTMLElement | null>(null);

// --- HEAD offscreen 検出 (フローティング Scroll-to-HEAD ボタン) ---

/** scroll 位置を reactive に持つ。scroll イベント + プログラム的スクロール (scrollTop 代入) の両方で発火する。 */
const scrollTop = ref(0);
useEventListener(scrollContainer, "scroll", () => {
  scrollTop.value = scrollContainer.value?.scrollTop ?? 0;
});
/** ビューポート高さ。resize / レイアウト変化に追従する (clientHeight 相当)。 */
const { height: viewportHeight } = useElementSize(scrollContainer);

/**
 * HEAD 行がビューポート外にあるか。ボタンをどちらの端に出すかを決める。
 * - "above": HEAD の行 top が sticky WorkingTree 行の下端より上 (上端で一部でも隠れる)
 * - "below": HEAD の行 bottom がビューポート下端を超える (下端で一部でも切れる)
 * - null: HEAD が sticky 行の下〜ビューポート下端に**完全に**収まるときのみ (ボタン不要)
 *
 * 行位置は既存スクロール座標 (`index * ROW_HEIGHT`) で表す。sticky な WorkingTree 行が上端 1 行分を
 * 覆うため、下端判定では行自身の高さと合わせて 2 行分を可視域から差し引く。
 */
const headOffscreen = computed<"above" | "below" | null>(() => {
  const head = headNode.value;
  const vh = viewportHeight.value;
  if (head === undefined || vh === 0) return null;
  const rowTop = head.index * ROW_HEIGHT;
  const st = scrollTop.value;
  if (rowTop < st) return "above";
  if (rowTop > st + vh - 2 * ROW_HEIGHT) return "below";
  return null;
});

/** above ボタンを sticky WorkingTree 行の直下に置くための top offset。 */
const aboveButtonTop = `${ROW_HEIGHT + 8}px`;

/** 現在選択中のノードの **行 (node) インデックス**。範囲選択中は compareHash（移動端）を返す。
 * gap 行挿入で commit index と node index がずれるため layout.nodes 上の位置を引く。未選択 / WT は -1。 */
function selectedIndex(): number {
  const { compareHash } = gitGraphStore;
  const hash = compareHash ?? gitGraphStore.selectedHash;
  return layout.value.nodes.findIndex((n) => !n.gap && n.commit.hash === hash);
}

/** index から dir 方向へ gap 行を読み飛ばした最初の非 gap 行を返す。範囲外はそのまま返し caller が clamp する。 */
function skipGapRows(index: number, dir: number): number {
  const nodes = layout.value.nodes;
  let i = index;
  while (i >= 0 && i < nodes.length && nodes[i]?.gap) i += dir;
  return i;
}

/** 選択を Uncommitted Changes に戻し、HEAD コミット付近にスクロール */
function scrollHeadIntoView() {
  const head = headNode.value;
  if (head === undefined) return;
  gitGraphStore.resetSelection();
  scrollToCenter(head.index);
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

// 親が HEAD スクロールを要求したとき (worktree 切替 / HEAD 移動 / Scroll to HEAD ボタン) 実行する。
// flush: "post" で DOM 反映後に走らせ、commits 変化直後 (行 / minHeight 未反映) の誤スクロールを避ける。
watch(
  () => gitGraphStore.scrollToHeadToken,
  () => scrollHeadIntoView(),
  { flush: "post" },
);

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
  const movingHash = gitGraphStore.compareHash ?? gitGraphStore.selectedHash;

  // selectedIndex の -1 は「移動端が真に Working Tree」と「選択コミットが表示から消えた
  // (branchScope 等の filter / stale)」の両方で起きるため、移動端 hash が UNCOMMITTED_HASH か
  // で区別する。filter で消えただけの -1 は起点が無いので Working Tree に倒し、次操作に委ねる。
  if (current === -1) {
    if (movingHash !== UNCOMMITTED_HASH) {
      gitGraphStore.select(UNCOMMITTED_HASH);
      return;
    }
    if (isUp) {
      scrollToIndex(0);
      return;
    }
    const next = skipGapRows(Math.min(step - 1, nodes.length - 1), 1);
    if (next >= nodes.length) return;
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
    next = skipGapRows(current - step, -1);
    // gap を上に抜けて Working Tree 域に出たら Working Tree 選択へ倒す。
    if (next < 0) {
      if (e.shiftKey) {
        gitGraphStore.selectCompare(UNCOMMITTED_HASH);
      } else {
        gitGraphStore.select(UNCOMMITTED_HASH);
      }
      return;
    }
  } else {
    next = skipGapRows(Math.min(nodes.length - 1, current + step), 1);
    if (next >= nodes.length) return;
  }

  if (e.shiftKey) {
    gitGraphStore.selectCompare(nodes[next].commit.hash);
  } else {
    gitGraphStore.select(nodes[next].commit.hash);
  }
  scrollToIndex(next);
}

function onRowClick(hash: string, e: MouseEvent) {
  // macOS WebKit は control+click を button=0 の click として dispatch する (webkit bugzilla 52174)。
  // contextmenu と一緒に通常 click も発火するため、control+click は選択変更に倒さず contextmenu 経路に委譲する。
  if (e.ctrlKey) return;
  if (e.shiftKey) {
    gitGraphStore.selectCompare(hash);
  } else {
    gitGraphStore.select(hash);
  }
}
</script>

<template>
  <!-- `--graph-cols` は master grid の列トラック SSOT (subgrid 共有の理由は <doc> 参照)。 -->
  <div
    class="relative flex min-w-0 flex-1 flex-col outline-none"
    :style="{ '--graph-cols': graphCols }"
    tabindex="0"
    @keydown="onKeydown"
  >
    <!-- HEAD が画面外のとき、戻る方向の端にフローティング Scroll-to-HEAD ボタンを出す。
         scrollContainer の外 (root 直下) に absolute で置き、スクロールに追従させない。
         色は primary (主 CTA) ではなく scroll アフォーダンス専用の深い青 (Slack の new-messages pill 相当)。
         theme 非依存の固定色で light/dark どちらでも同じ見え方にする。 -->
    <button
      v-if="headOffscreen === 'above'"
      type="button"
      class="absolute inset-x-0 z-20 mx-auto flex w-fit items-center gap-1 rounded-full bg-scroll-pill px-2.5 py-1 text-[10px] font-semibold text-scroll-pill-foreground shadow-lg hover:bg-scroll-pill-hover"
      :style="{ top: aboveButtonTop }"
      title="Scroll to HEAD"
      @click="scrollHeadIntoView"
    >
      <IconLucideArrowUp class="size-3" />
      HEAD
    </button>
    <button
      v-else-if="headOffscreen === 'below'"
      type="button"
      class="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit items-center gap-1 rounded-full bg-scroll-pill px-2.5 py-1 text-[10px] font-semibold text-scroll-pill-foreground shadow-lg hover:bg-scroll-pill-hover"
      title="Scroll to HEAD"
      @click="scrollHeadIntoView"
    >
      <IconLucideArrowDown class="size-3" />
      HEAD
    </button>

    <!-- スクロール可能なコミットリスト。Working Tree 行 (sticky) と commit 行を 1 枚の master grid の
         直接の子として並べ、各行は subgrid で master の列トラックを共有する。列整合の SSOT はここ。 -->
    <div ref="scrollContainer" class="min-h-0 flex-1 overflow-auto">
      <div class="relative grid" :style="{ gridTemplateColumns: 'var(--graph-cols)' }">
        <WorkingTreeRow
          :graph-column-width="graphColumnWidth"
          :head-color="headColor"
          :change-count="uncommittedChangeCount"
          :status-icons="statusIcons"
          :mtime="workingTreeMtime"
          @row-click="onRowClick(UNCOMMITTED_HASH, $event)"
        />

        <!-- グラフの dot / lane を描く overlay。commit 行域 (WorkingTree 行の下) に重ねるため
             ROW_HEIGHT 分下げて absolute 配置する。行 background の上に描かれる (positioned = 上位 layer)。 -->
        <div
          class="pointer-events-none absolute left-0"
          :style="{
            top: `${ROW_HEIGHT}px`,
            width: `${graphColumnWidth}px`,
            height: `${svgHeight}px`,
          }"
        >
          <GraphSvgOverlay
            :layout="layout"
            :graph-column-width="graphColumnWidth"
            :head-color="headColor"
            :head-row="headNode?.index ?? -1"
          />
        </div>

        <template v-for="(node, row) in layout.nodes" :key="`row-${row}`">
          <GapRow v-if="node.gap" />
          <CommitRow
            v-else
            :node="node"
            :current-branch="currentBranch"
            :default-branch="defaultBranch"
            :out-of-sync-branches="outOfSyncBranches"
            :pr-by-branch="prByBranch"
            :segments="commitMessageSegmentsByHash.get(node.commit.hash) ?? []"
            @row-click="onRowClick"
            @row-contextmenu="emit('commitContextmenu', $event)"
          />
        </template>
      </div>
    </div>
  </div>
</template>
