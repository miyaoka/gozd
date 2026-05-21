<doc lang="md">
共有 ⋮ ポップオーバーメニュー。

開閉と context は `useSidebarMenu` (module singleton) 経由で共有する。
このコンポーネントは context を購読して描画し、アクション click を emit するだけ。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { useSidebarMenu } from "./useSidebarMenu";

const emit = defineEmits<{
  worktreeRemove: [wt: WorktreeEntry, rootDir: string];
  taskRemove: [task: Task, rootDir: string];
}>();

const { PopoverRoot, context, close } = useSidebarMenu();

function handleWorktreeRemove(wt: WorktreeEntry, rootDir: string) {
  close();
  emit("worktreeRemove", wt, rootDir);
}

function handleTaskRemove(task: Task, rootDir: string) {
  close();
  emit("taskRemove", task, rootDir);
}
</script>

<template>
  <PopoverRoot
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
  >
    <template v-if="context?.type === 'worktree' && context.worktree">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleWorktreeRemove(context.worktree, context.rootDir)"
      >
        <span class="icon-[lucide--unlink] text-xs" />
        Remove worktree
      </button>
    </template>
    <template v-else-if="context?.type === 'task' && context.task">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleTaskRemove(context.task, context.rootDir)"
      >
        <span class="icon-[lucide--trash-2] text-xs" />
        Remove task
      </button>
    </template>
  </PopoverRoot>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
