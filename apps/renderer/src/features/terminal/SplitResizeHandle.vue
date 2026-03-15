<doc lang="md">
split tree の branch ノード間に配置する ratio ベースのリサイズハンドル。
見た目は既存の ResizeHandle と統一する。
</doc>

<script setup lang="ts">
import { useElementHover } from "@vueuse/core";
import { computed, useTemplateRef } from "vue";
import type { Axis, SplitNode } from "./splitTree";
import { useSplitResize } from "./useSplitResize";
import { useTerminalStore } from "./useTerminalStore";

interface Props {
  dir: string;
  branchId: string;
  axis: Axis;
  ratio: number;
  firstNode: SplitNode;
  secondNode: SplitNode;
}

const props = defineProps<Props>();

const terminalStore = useTerminalStore();
const handleRef = useTemplateRef<HTMLElement>("handle");
const isHovered = useElementHover(handleRef);

const firstNodeRef = computed(() => props.firstNode);
const secondNodeRef = computed(() => props.secondNode);
const ratioRef = computed(() => props.ratio);

const { isDragging } = useSplitResize(handleRef, {
  axis: props.axis,
  firstNode: firstNodeRef,
  secondNode: secondNodeRef,
  ratio: ratioRef,
  onUpdate: (newRatio) => {
    terminalStore.resizeBranch(props.dir, props.branchId, newRatio);
  },
  onDragStart: () => {
    terminalStore.incrementDragSuspend();
  },
  onDragEnd: () => {
    terminalStore.decrementDragSuspend();
  },
});
</script>

<template>
  <div
    ref="handle"
    class="z-10 flex shrink-0 items-center justify-center"
    :class="axis === 'horizontal' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'"
  >
    <div
      class="pointer-events-none transition-colors duration-150"
      :class="[
        axis === 'horizontal' ? 'h-full w-px' : 'h-px w-full',
        isDragging || isHovered ? 'bg-blue-500' : 'bg-zinc-700',
      ]"
    />
  </div>
</template>
