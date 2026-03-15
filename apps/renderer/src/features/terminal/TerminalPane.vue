<doc lang="md">
ターミナルペイン。worktree ごとの分割ツリーをフラットにレンダリングする。

## レイアウト方式

再帰コンポーネントではなく、flattenTree() でツリーを走査し全 leaf / handle の
絶対位置（px）を算出。v-for + position: absolute でフラットに配置する。
ツリー構造が変わっても既存 leaf の key(id) が同じなので Vue がコンポーネントを
再利用し、xterm インスタンスと PTY のリマウントが起きない。
</doc>

<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { computed, ref } from "vue";
import SplitResizeHandle from "./SplitResizeHandle.vue";
import type { FlatHandle, FlatLeaf } from "./splitTree";
import { flattenTree } from "./splitTree";
import TerminalLeaf from "./TerminalLeaf.vue";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{
  dir: string;
  fitSuspended?: boolean;
}>();

const terminalStore = useTerminalStore();
const layout = computed(() => terminalStore.ensureLayout(props.dir));

const containerRef = ref<HTMLElement>();
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef);

const flatElements = computed(() =>
  flattenTree(layout.value.root, containerWidth.value, containerHeight.value),
);

const flatLeaves = computed(() =>
  flatElements.value.filter((el): el is FlatLeaf => el.type === "leaf"),
);

const flatHandles = computed(() =>
  flatElements.value.filter((el): el is FlatHandle => el.type === "handle"),
);

function rectStyle(rect: { top: number; left: number; width: number; height: number }) {
  return {
    position: "absolute" as const,
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}
</script>

<template>
  <div ref="containerRef" class="relative size-full overflow-hidden">
    <TerminalLeaf
      v-for="leaf in flatLeaves"
      :key="leaf.id"
      :dir="dir"
      :leaf-id="leaf.id"
      :fit-suspended="fitSuspended"
      :style="rectStyle(leaf.rect)"
    />

    <SplitResizeHandle
      v-for="handle in flatHandles"
      :key="handle.branchId"
      :dir="dir"
      :branch-id="handle.branchId"
      :axis="handle.axis"
      :ratio="handle.ratio"
      :first-node="handle.firstNode"
      :second-node="handle.secondNode"
      :available-px="handle.availablePx"
      :style="rectStyle(handle.rect)"
    />
  </div>
</template>
