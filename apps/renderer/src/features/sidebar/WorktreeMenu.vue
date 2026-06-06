<doc lang="md">
worktree カードの ⋮ ポップオーバーメニュー。Remove worktree アクションを表示する。
state は `useWorktreeMenu` (module singleton) 経由で SidebarPane と共有する。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/proto";
import { useWorktreeMenu } from "./useWorktreeMenu";

const emit = defineEmits<{
  remove: [wt: WorktreeEntry, rootDir: string];
}>();

const { Popover, context, close } = useWorktreeMenu();

function handleRemove() {
  if (!context.value) return;
  const { worktree, rootDir } = context.value;
  close();
  emit("remove", worktree, rootDir);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <button
      v-if="context"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
      @click="handleRemove"
    >
      <span class="icon-[lucide--unlink] text-xs" />
      Remove worktree
    </button>
  </Popover>
</template>
