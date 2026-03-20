<doc lang="md">
サイドバーの ROOT セクション。リポジトリのメイン worktree（main ブランチ）を表示する。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@orkis/rpc";
import { hasChanges } from "../utils";

defineProps<{
  worktree: WorktreeEntry | undefined;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [wt: WorktreeEntry];
}>();
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
      <span class="flex min-h-5 items-center gap-2 text-xs">
        <span
          v-if="worktree.changeCounts && hasChanges(worktree.changeCounts)"
          class="flex items-center gap-1.5"
        >
          <span v-if="worktree.changeCounts.modified > 0" class="text-yellow-500">
            <span class="mr-0.5 icon-[lucide--pencil] align-middle text-[10px]" />{{
              worktree.changeCounts.modified
            }}
          </span>
          <span v-if="worktree.changeCounts.added > 0" class="text-green-500">
            <span class="mr-0.5 icon-[lucide--plus] align-middle text-[10px]" />{{
              worktree.changeCounts.added
            }}
          </span>
          <span v-if="worktree.changeCounts.deleted > 0" class="text-red-500">
            <span class="mr-0.5 icon-[lucide--minus] align-middle text-[10px]" />{{
              worktree.changeCounts.deleted
            }}
          </span>
          <span v-if="worktree.changeCounts.untracked > 0" class="text-zinc-400">
            <span class="mr-0.5 icon-[lucide--help-circle] align-middle text-[10px]" />{{
              worktree.changeCounts.untracked
            }}
          </span>
        </span>
      </span>
    </button>
  </div>
</template>
