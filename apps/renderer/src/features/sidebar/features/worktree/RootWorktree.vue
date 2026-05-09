<doc lang="md">
サイドバーの ROOT セクション。リポジトリのメイン worktree（main ブランチ）を表示する。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/proto";
import { computed } from "vue";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { hasChanges } from "../../utils";

const props = defineProps<{
  worktree: WorktreeEntry | undefined;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [wt: WorktreeEntry];
}>();

const statusIcons = computed(() => {
  if (!props.worktree?.gitStatuses) return [];
  return computeStatusIcons(props.worktree.gitStatuses);
});
</script>

<template>
  <div v-if="worktree" class="flex flex-col">
    <h2 class="mb-1 text-xs font-medium text-zinc-500">ROOT</h2>
    <button
      class="grid w-full grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left"
      :class="active ? 'bg-zinc-700/50' : 'hover:bg-zinc-800'"
      @click="emit('select', worktree)"
    >
      <span class="row-span-2 mt-0.5 icon-[lucide--home] text-base text-zinc-500" />
      <span
        class="truncate text-sm"
        :class="active ? 'font-medium text-blue-300' : 'text-zinc-400'"
      >
        {{ worktree.branch ?? "(detached)" }}
      </span>
      <span
        v-if="worktree.gitStatuses && hasChanges(worktree.gitStatuses)"
        class="flex min-h-5 items-center gap-1 text-xs"
      >
        <StatusIcons :entries="statusIcons" />
      </span>
    </button>
  </div>
</template>
