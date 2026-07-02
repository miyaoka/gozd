<doc lang="md">
commit graph のレーン / ドットを描く SVG overlay。commit 行の上に absolute で重ね、同じ行 index
座標系で dot を各行に合わせる。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useGitGraphStore } from "../../useGitGraphStore";
import { laneTextColor } from "./graphColors";
import { DOT_RADIUS, ROW_HEIGHT, laneX, rowY, segmentPath } from "./graphGeometry";
import type { GraphLayout } from "./graphLayout";

const props = defineProps<{
  layout: GraphLayout;
  /** SVG の描画幅 (px) */
  graphColumnWidth: number;
  /** HEAD レーンの色インデックス。接続ダッシュ線の色に使う */
  headColor: number;
}>();

const gitGraphStore = useGitGraphStore();

/** グラフ全体の SVG 高さ */
const svgHeight = computed(() => props.layout.nodes.length * ROW_HEIGHT);

/** refs に "HEAD" を持つ表示中ノードの行番号。不在時は -1 */
const headIndex = computed(() =>
  props.layout.nodes.findIndex((n) => n.commit.refs.includes("HEAD")),
);

/**
 * Working Tree 固定行 → HEAD コミットへの接続ダッシュ線パス。
 * HEAD は表示集合内では常に lane 0 に固定されるため、lane 0 上端から HEAD 行まで降りる垂直直線。
 */
const connectorPath = computed(() => {
  if (headIndex.value === -1) return "";
  const x0 = laneX(0);
  return `M${x0},0L${x0},${rowY(headIndex.value)}`;
});
</script>

<template>
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
      :stroke="laneTextColor(headColor)"
      stroke-width="2"
      stroke-dasharray="4 2"
    />
    <!-- ラインセグメント -->
    <path
      v-for="(seg, si) in layout.lines"
      :key="`seg-${si}`"
      :d="segmentPath(seg.x1, seg.y1, seg.x2, seg.y2)"
      fill="none"
      :stroke="laneTextColor(seg.color)"
      stroke-width="2"
    />
    <!-- コミットドット (gap 行は dot を描かない) -->
    <circle
      v-for="(node, row) in layout.nodes"
      v-show="!node.gap"
      :key="`dot-${node.commit.hash}`"
      :cx="laneX(node.lane)"
      :cy="rowY(row)"
      :r="gitGraphStore.isActiveDot(node.commit.hash) ? DOT_RADIUS + 1 : DOT_RADIUS"
      :fill="
        gitGraphStore.isActiveDot(node.commit.hash) ? laneTextColor(node.color) : 'currentColor'
      "
      :stroke="laneTextColor(node.color)"
      :stroke-width="gitGraphStore.isActiveDot(node.commit.hash) ? 2 : 1.5"
      class="text-background"
    />
  </svg>
</template>
