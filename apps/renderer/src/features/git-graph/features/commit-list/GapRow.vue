<doc lang="md">
commit graph の「履歴の途切れ」を示す全幅 separator 行。行高は commit 行と揃え、SVG の
行 index 座標系を崩さない。途切れが挿入される条件は GitGraphPane の doc を参照。

ラベルを lane 0 に揃えるため、他の行と同じく subgrid で列トラックを共有し、graph 列から先に
文言を置く。左端の date 列は空セルで飛ばす (行左端からの padding では date 列の
content 幅ぶんずれる)。
</doc>

<script setup lang="ts">
import { GRAPH_PADDING_X, LANE_WIDTH, ROW_HEIGHT } from "./graphGeometry";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
</script>

<template>
  <div
    class="col-span-full grid grid-cols-subgrid items-center bg-panel text-xs text-foreground-low select-none"
    :style="{ height: `${ROW_HEIGHT}px` }"
  >
    <!-- col 1 (date): 空セル -->
    <div></div>

    <!-- col 2 (graph) 以降: lane 0 に揃えた文言 -->
    <div
      class="_graph-gap-label col-start-2 -col-end-1 flex items-center gap-[0.5ch]"
      :style="{ paddingLeft: `${GRAPH_PADDING_X + LANE_WIDTH}px` }"
    >
      <IconLucideMoreHorizontal class="size-3.5 shrink-0" />
      <span>Earlier history hidden</span>
    </div>
  </div>
</template>
