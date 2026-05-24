<doc lang="md">
task 行の ⋮ ポップオーバーメニュー。Edit title / Remove task アクションを表示する。
state は `useTaskMenu` (module singleton) 経由で SidebarPane と共有する。
Edit title は `useTaskEditing.open` 経由で TaskEditDialog を開く。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/proto";
import { useTaskEditing } from "./useTaskEditing";
import { useTaskMenu } from "./useTaskMenu";

const emit = defineEmits<{
  remove: [task: Task, rootDir: string];
}>();

const { Popover, context, close } = useTaskMenu();
const { open: openEdit } = useTaskEditing();

function handleEdit() {
  if (!context.value) return;
  const { task, rootDir } = context.value;
  close();
  openEdit(task.id, rootDir);
}

function handleRemove() {
  if (!context.value) return;
  const { task, rootDir } = context.value;
  close();
  emit("remove", task, rootDir);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      position: 'fixed',
      top: 'anchor(bottom)',
      left: 'anchor(left)',
      positionTryFallbacks: 'flip-block, flip-inline',
    }"
  >
    <template v-if="context">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
        @click="handleEdit"
      >
        <span class="icon-[lucide--pencil] text-xs" />
        Edit title
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleRemove"
      >
        <span class="icon-[lucide--trash-2] text-xs" />
        Remove task
      </button>
    </template>
  </Popover>
</template>
