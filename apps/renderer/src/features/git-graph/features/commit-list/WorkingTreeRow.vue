<doc lang="md">
commit graph の Working Tree 固定行。master grid の subgrid として commit 行と同じ列トラックを
共有し (`grid-cols-subgrid`)、sticky で最上部に留まる。列整合は subgrid が保証する
(scroll bar の有無やセル内容差に影響されない)。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { formatCompactTime } from "../../../../shared/time";
import { StatusIcons, UNCOMMITTED_HASH, type StatusIconEntry } from "../../../worktree";
import { useGitGraphStore } from "../../useGitGraphStore";
import { laneTextColor } from "./graphColors";
import { DOT_RADIUS, ROW_HEIGHT, laneX } from "./graphGeometry";

defineProps<{
  /** graph 列の幅 (px)。SVG の描画幅に使う */
  graphColumnWidth: number;
  /** HEAD レーンの色インデックス。Working Tree のドット/接続線を HEAD と同色に揃える */
  headColor: number;
  /** 変更ファイル数。0 のとき "(Clean)" 表示 */
  changeCount: number;
  /** 変更をアイコン付きカウントに変換したもの */
  statusIcons: StatusIconEntry[];
  /** 変更ファイルの mtime 最大値 (unix 秒)。0 は空表示 */
  mtime: number;
}>();

const emit = defineEmits<{
  rowClick: [e: MouseEvent];
}>();

const gitGraphStore = useGitGraphStore();

/** 単一 Working Tree 選択 / 範囲選択の片端が Working Tree のときドットを強調する */
const isActive = computed(() => gitGraphStore.includesWorkingTree);

const highlightClass = computed(() =>
  gitGraphStore.isSelectedRow(UNCOMMITTED_HASH)
    ? "bg-primary-subtle hover:bg-primary-subtle-hover"
    : "hover:bg-element-hover",
);
</script>

<template>
  <div
    class="_graph-row sticky top-0 z-10 col-span-full grid grid-cols-subgrid items-center border-b border-border-subtle bg-background text-xs"
    :class="highlightClass"
    :style="{ height: `${ROW_HEIGHT}px` }"
    @click="emit('rowClick', $event)"
  >
    <!-- Working Tree 行の SVG: lane 0 にドット、下端へダッシュ線。grid 上に absolute で重ねる -->
    <svg
      class="pointer-events-none absolute top-0 left-0"
      :width="graphColumnWidth"
      :height="ROW_HEIGHT"
    >
      <circle
        :cx="laneX(0)"
        :cy="ROW_HEIGHT / 2"
        :r="isActive ? DOT_RADIUS + 1 : DOT_RADIUS"
        :fill="isActive ? laneTextColor(headColor) : 'currentColor'"
        :stroke="laneTextColor(headColor)"
        stroke-width="2"
        class="text-background"
      />
      <line
        :x1="laneX(0)"
        :y1="ROW_HEIGHT / 2 + DOT_RADIUS"
        :x2="laneX(0)"
        :y2="ROW_HEIGHT"
        :stroke="laneTextColor(headColor)"
        stroke-width="2"
        stroke-dasharray="4 2"
      />
    </svg>

    <!-- col 1 (graph): SVG が absolute で覆うので空セル -->
    <div />

    <!-- col 2 (description) -->
    <div class="flex min-w-0 items-center gap-1 truncate px-1">
      <span class="truncate font-semibold text-foreground-low">Working Tree</span>
      <span v-if="changeCount === 0" class="text-foreground-low italic"> (Clean) </span>
      <StatusIcons v-else :entries="statusIcons" icon-size="size-4" />
    </div>

    <!-- col 3 (date): 変更ファイルの mtime 最大値。clean / 未取得時は空表示。 -->
    <div class="truncate px-1 text-foreground-low">
      {{ formatCompactTime(mtime) }}
    </div>
    <!-- col 4 (author) / col 5 (hash) は空セル。grid template が幅を確保する。 -->
  </div>
</template>
