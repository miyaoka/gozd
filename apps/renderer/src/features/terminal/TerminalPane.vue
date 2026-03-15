<doc lang="md">
ターミナルペイン。worktree ごとの分割ツリーを SplitContainer で再帰レンダリングする。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import SplitContainer from "./SplitContainer.vue";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{
  dir: string;
  fitSuspended?: boolean;
}>();

const terminalStore = useTerminalStore();
const layout = computed(() => terminalStore.ensureLayout(props.dir));
</script>

<template>
  <div class="flex size-full flex-col">
    <div class="min-h-0 flex-1">
      <SplitContainer :node="layout.root" :dir="dir" :fit-suspended="fitSuspended" />
    </div>
  </div>
</template>
