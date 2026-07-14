<doc lang="md">
worktree カードの ⋮ ポップオーバーメニュー。Remove all tasks / Remove worktree アクションを表示する。
state は `useWorktreeMenu` (module singleton) 経由で SidebarPane と共有する。

項目の出し分けは worktree の性質で決まる:

- Remove all tasks: task が 1 件以上ある wt のみ。`git worktree remove` できない main worktree でも
  滞留 task/session を一掃できるようにする（worktree 削除 cascade の task 掃除だけを単独発火）
- Remove worktree: main worktree は remove 不可のため非 main のみ
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import { useWorktreeMenu } from "./useWorktreeMenu";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideUnlink from "~icons/lucide/unlink";

const emit = defineEmits<{
  remove: [wt: WorktreeEntry, rootDir: string];
  removeAllTasks: [wt: WorktreeEntry, rootDir: string];
}>();

const { Popover, context, close } = useWorktreeMenu();

const canRemoveWorktree = computed(() => context.value?.worktree.isMain === false);
const hasTasks = computed(() => (context.value?.worktree.tasks.length ?? 0) > 0);

function handleRemove() {
  if (!context.value) return;
  const { worktree, rootDir } = context.value;
  close();
  emit("remove", worktree, rootDir);
}

function handleRemoveAllTasks() {
  if (!context.value) return;
  const { worktree, rootDir } = context.value;
  close();
  emit("removeAllTasks", worktree, rootDir);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <button
        v-if="hasTasks"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive-text hover:bg-panel"
        @click="handleRemoveAllTasks"
      >
        <IconLucideTrash2 class="text-xs" />
        Remove all tasks
      </button>
      <button
        v-if="canRemoveWorktree"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive-text hover:bg-panel"
        @click="handleRemove"
      >
        <IconLucideUnlink class="text-xs" />
        Remove worktree
      </button>
    </template>
  </Popover>
</template>
