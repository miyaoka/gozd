<doc lang="md">
サイドバーの WORKTREES セクション。Task 紐づき済みの worktree 一覧を表示する。

各 worktree 行の後にスロットを提供し、親コンポーネントがインライン Task 編集を差し込める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/proto";
import type { ClaudeStatus } from "../../../terminal";
import WorktreeItem from "./WorktreeItem.vue";

defineProps<{
  worktrees: WorktreeEntry[];
  /** worktree データ未取得（初回ロード中） */
  loading: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  now: number;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
  getResumeableSessionCount: (dir: string) => number;
}>();

defineEmits<{
  select: [wt: WorktreeEntry];
  openMenu: [anchorEl: HTMLElement, wt: WorktreeEntry];
  add: [];
}>();

defineSlots<{
  "after-item"(props: { wt: WorktreeEntry }): unknown;
}>();
</script>

<template>
  <div class="mt-4 flex flex-col gap-1.5">
    <h2 class="mb-1 text-xs font-medium text-zinc-500">WORKTREES</h2>

    <button
      class="grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
      :disabled="isCreating"
      @click="$emit('add')"
    >
      <span
        class="text-base"
        :class="isCreating ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--plus]'"
      />
      <span>New worktree</span>
    </button>

    <p v-if="loading" class="py-2 pl-2 text-sm text-zinc-500">Loading...</p>

    <div v-for="wt in worktrees" :key="wt.path">
      <WorktreeItem
        :wt="wt"
        :active="activeDir === wt.path"
        :claude-statuses="getClaudeStatuses(wt.path)"
        :resumeable-session-count="getResumeableSessionCount(wt.path)"
        :now="now"
        @select="$emit('select', $event)"
        @open-menu="(anchorEl, w) => $emit('openMenu', anchorEl, w)"
      />
      <slot name="after-item" :wt="wt" />
    </div>
  </div>
</template>
