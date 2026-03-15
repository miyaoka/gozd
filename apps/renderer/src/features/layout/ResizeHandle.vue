<doc lang="md">
ペイン間のドラッグリサイズハンドル。水平・垂直の両方向に対応する。

ドラッグ操作でハンドル左右（上下）のペインサイズを連動して増減する。
`v-model:before-size` と `v-model:after-size` で親と同期する。
</doc>

<script setup lang="ts">
import { useElementHover } from "@vueuse/core";
import { useTemplateRef } from "vue";
import { useResize } from "./useResize";

interface Props {
  direction: "horizontal" | "vertical";
  beforeMinSize: number;
  afterMinSize: number;
  getBeforeSize?: () => number;
  getAfterSize?: () => number;
}

const props = defineProps<Props>();
const beforeSize = defineModel<number>("beforeSize");
const afterSize = defineModel<number>("afterSize");

const handleRef = useTemplateRef<HTMLElement>("handle");
const isHovered = useElementHover(handleRef);

const { isDragging } = useResize(handleRef, beforeSize, afterSize, {
  direction: props.direction,
  beforeMinSize: props.beforeMinSize,
  afterMinSize: props.afterMinSize,
  getBeforeSize: props.getBeforeSize,
  getAfterSize: props.getAfterSize,
});
</script>

<template>
  <div
    ref="handle"
    class="z-10 flex shrink-0 items-center justify-center"
    :class="direction === 'horizontal' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'"
  >
    <div
      class="pointer-events-none transition-colors duration-150"
      :class="[
        direction === 'horizontal' ? 'h-full w-px' : 'h-px w-full',
        isDragging || isHovered ? 'bg-blue-500' : 'bg-zinc-700',
      ]"
    />
  </div>
</template>
