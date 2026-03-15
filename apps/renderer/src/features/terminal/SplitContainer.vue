<doc lang="md">
SplitNode を再帰的にレンダリングするコンテナ。

- branch: flex-row（horizontal）/ flex-col（vertical）で first + handle + second を配置
- leaf: TerminalLeaf を描画
</doc>

<script setup lang="ts">
import SplitResizeHandle from "./SplitResizeHandle.vue";
import type { SplitBranch, SplitNode } from "./splitTree";
import TerminalLeaf from "./TerminalLeaf.vue";

interface Props {
  node: SplitNode;
  dir: string;
  fitSuspended?: boolean;
}

defineProps<Props>();
</script>

<template>
  <!-- leaf: TerminalLeaf を描画 -->
  <TerminalLeaf
    v-if="node.type === 'leaf'"
    :dir="dir"
    :leaf-id="node.id"
    :fit-suspended="fitSuspended"
  />

  <!-- branch: 再帰的に子ノードを配置 -->
  <div
    v-else
    class="flex size-full"
    :class="node.direction === 'horizontal' ? 'flex-row' : 'flex-col'"
  >
    <div
      class="min-h-0 min-w-0 overflow-hidden"
      :style="{
        flex: `${(node as SplitBranch).ratio} 1 0%`,
      }"
    >
      <SplitContainer
        :node="(node as SplitBranch).first"
        :dir="dir"
        :fit-suspended="fitSuspended"
      />
    </div>

    <SplitResizeHandle
      :dir="dir"
      :branch-id="node.id"
      :axis="(node as SplitBranch).direction"
      :ratio="(node as SplitBranch).ratio"
      :first-node="(node as SplitBranch).first"
      :second-node="(node as SplitBranch).second"
    />

    <div
      class="min-h-0 min-w-0 overflow-hidden"
      :style="{
        flex: `${1 - (node as SplitBranch).ratio} 1 0%`,
      }"
    >
      <SplitContainer
        :node="(node as SplitBranch).second"
        :dir="dir"
        :fit-suspended="fitSuspended"
      />
    </div>
  </div>
</template>
