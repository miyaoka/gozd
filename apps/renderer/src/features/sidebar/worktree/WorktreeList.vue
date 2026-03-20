<doc lang="md">
サイドバーの WORKTREES セクション。Todo 紐づき済みの worktree 一覧を表示する。

各 worktree 行の後にスロットを提供し、親コンポーネントがインライン Todo 編集を差し込める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@orkis/rpc";
import type { ClaudeStatus } from "../../terminal/useTerminalStore";
import WorktreeItem from "./WorktreeItem.vue";

defineProps<{
  worktrees: WorktreeEntry[];
  /** worktree データ未取得（初回ロード中） */
  loading: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  ctrlPressed: boolean;
  now: number;
  showAll: boolean;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
}>();

defineEmits<{
  select: [wt: WorktreeEntry];
  openMenu: [anchorName: string, wt: WorktreeEntry];
  add: [];
  toggleShowAll: [];
}>();

defineSlots<{
  "after-item"(props: { wt: WorktreeEntry }): unknown;
}>();
</script>

<template>
  <div class="mt-4 flex flex-col">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="text-xs font-medium text-zinc-500">WORKTREES</h2>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        :class="showAll && 'bg-zinc-700 text-zinc-200'"
        title="Show all worktree terminals"
        @click="$emit('toggleShowAll')"
      >
        <span class="icon-[lucide--layout-grid] text-sm" />
      </button>
    </div>

    <div v-for="(wt, i) in worktrees" :key="wt.path">
      <WorktreeItem
        :wt="wt"
        :active="activeDir === wt.path"
        :claude-statuses="getClaudeStatuses(wt.path)"
        :now="now"
        :anchor-name="`--wt-menu-${i}`"
        :ctrl-pressed="ctrlPressed"
        :index="i"
        @select="$emit('select', $event)"
        @open-menu="(anchorName, w) => $emit('openMenu', anchorName, w)"
      />
      <slot name="after-item" :wt="wt" />
    </div>

    <p v-if="loading" class="py-2 pl-2 text-sm text-zinc-500">Loading...</p>

    <button
      class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      :disabled="isCreating"
      @click="$emit('add')"
    >
      <span class="icon-[lucide--plus] text-base" />
      <span>New worktree</span>
    </button>
  </div>
</template>
