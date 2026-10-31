<script setup lang="ts">
import { GRAPH_PADDING_X, LANE_WIDTH, ROW_HEIGHT } from "./graphGeometry";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
</script>

<template>
  <div
    class="col-span-full grid grid-cols-subgrid items-center bg-panel text-xs text-foreground-low select-none"
    :style="{ height: `${ROW_HEIGHT}px` }"
  >
    <!-- graph 列から行末まで。lane 0 に揃えた文言 -->
    <div
      class="_graph-gap-label flex items-center gap-[0.5ch]"
      :style="{
        gridColumn: 'graph / -1',
        paddingLeft: `${GRAPH_PADDING_X + LANE_WIDTH}px`,
      }"
    >
      <IconLucideMoreHorizontal class="size-3.5 shrink-0" />
      <span>Earlier history hidden</span>
    </div>
  </div>
</template>
