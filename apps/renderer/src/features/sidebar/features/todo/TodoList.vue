<doc lang="md">
サイドバーの TODOS セクション。未着手の Todo（worktree 未紐づけ）の一覧を表示する。

各 Todo 行の後と末尾にスロットを提供し、インライン編集フォームや新規追加フォームを差し込める。
アイコンは TodoIconButton で直接クリック → popover ピッカーで変更できる。
</doc>

<script setup lang="ts">
import type { Todo } from "@gozd/rpc";
import { todoTitle } from "../../utils";
import TodoIconButton from "./TodoIconButton.vue";

defineProps<{
  todos: Todo[];
  editingTodoId: string | undefined;
  isAddingTodo: boolean;
}>();

defineEmits<{
  toggleEdit: [todo: Todo];
  openMenu: [anchorName: string, todo: Todo];
  startAdd: [];
  updateIcon: [todo: Todo, icon: string | undefined];
}>();

defineSlots<{
  "after-item"(props: { todo: Todo }): unknown;
  "add-form"(): unknown;
}>();
</script>

<template>
  <div class="mt-4 flex flex-col">
    <h2 class="mb-1 text-xs font-medium text-zinc-500">TODOS</h2>

    <div v-for="(todo, i) in todos" :key="todo.id">
      <div
        class="group/td relative grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 hover:bg-zinc-800"
      >
        <TodoIconButton :icon="todo.icon" @update="$emit('updateIcon', todo, $event)">
          <span class="text-zinc-600">☐</span>
        </TodoIconButton>
        <button
          class="truncate text-left text-sm text-zinc-400 after:absolute after:inset-0"
          @click="$emit('toggleEdit', todo)"
        >
          {{ todoTitle(todo.body) || "(untitled)" }}
        </button>
        <!-- ⋮ メニューボタン -->
        <button
          aria-label="Menu"
          class="relative z-10 grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/td:opacity-100 group-hover/td:opacity-100 hover:text-zinc-300"
          :style="{ anchorName: `--todo-menu-${i}` }"
          @click="$emit('openMenu', `--todo-menu-${i}`, todo)"
        >
          <span class="icon-[lucide--ellipsis-vertical] text-sm" />
        </button>
      </div>

      <slot name="after-item" :todo="todo" />
    </div>

    <slot name="add-form" />

    <button
      v-if="!isAddingTodo"
      class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      @click="$emit('startAdd')"
    >
      <span class="icon-[lucide--plus] text-base" />
      <span>New todo</span>
    </button>
  </div>
</template>
