<doc lang="md">
サイドバーの TASKS セクション。未着手の Task（worktree 未紐づけ）の一覧を表示する。

各 Task 行の後と末尾にスロットを提供し、インライン編集フォームや新規追加フォームを差し込める。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/rpc";
import { taskTitle } from "../../utils";

defineProps<{
  tasks: Task[];
  editingTaskId: string | undefined;
  isAddingTask: boolean;
}>();

defineEmits<{
  toggleEdit: [task: Task];
  openMenu: [anchorName: string, task: Task];
  startAdd: [];
}>();

defineSlots<{
  "after-item"(props: { task: Task }): unknown;
  "add-form"(): unknown;
}>();
</script>

<template>
  <div class="mt-4 flex flex-col">
    <h2 class="mb-1 text-xs font-medium text-zinc-500">TASKS</h2>

    <div v-for="(task, i) in tasks" :key="task.id">
      <div
        class="group/td relative grid grid-cols-[1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 hover:bg-zinc-800"
      >
        <button
          class="text-left text-sm text-zinc-400 after:absolute after:inset-0"
          @click="$emit('toggleEdit', task)"
        >
          <span class="line-clamp-2">{{ taskTitle(task.body) || "(untitled)" }}</span>
        </button>
        <!-- ⋮ メニューボタン -->
        <button
          aria-label="Menu"
          class="relative z-10 grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/td:opacity-100 group-hover/td:opacity-100 hover:text-zinc-300"
          :style="{ anchorName: `--task-menu-${i}` }"
          @click="$emit('openMenu', `--task-menu-${i}`, task)"
        >
          <span class="icon-[lucide--ellipsis-vertical] text-sm" />
        </button>
      </div>

      <slot name="after-item" :task="task" />
    </div>

    <slot name="add-form" />

    <button
      v-if="!isAddingTask"
      class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      @click="$emit('startAdd')"
    >
      <span class="icon-[lucide--plus] text-base" />
      <span>New task</span>
    </button>
  </div>
</template>
