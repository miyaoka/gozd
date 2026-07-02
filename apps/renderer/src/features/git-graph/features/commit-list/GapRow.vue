<doc lang="md">
commit graph の「履歴の途切れ」を示す全幅 separator 行。行高は commit 行と揃え、SVG の
行 index 座標系を崩さない。途切れが挿入される条件は GitGraphPane の doc を参照。
</doc>

<script setup lang="ts">
import { GRAPH_PADDING_X, LANE_WIDTH, ROW_HEIGHT } from "./graphGeometry";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
</script>

<template>
  <div
    class="flex items-center gap-[0.5ch] bg-panel text-xs text-foreground-low select-none"
    :style="{ height: `${ROW_HEIGHT}px`, paddingLeft: `${GRAPH_PADDING_X + LANE_WIDTH}px` }"
  >
    <IconLucideMoreHorizontal class="size-3.5 shrink-0" />
    <span>Earlier history hidden</span>
  </div>
</template>
