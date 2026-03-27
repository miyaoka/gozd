<doc lang="md">
サイドバーの WORKTREES セクション。Task 紐づき済みの worktree 一覧を表示する。

各 worktree 行の後にスロットを提供し、親コンポーネントがインライン Task 編集を差し込める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import type { ClaudeStatus } from "../../../terminal";
import WorktreeItem from "./WorktreeItem.vue";

type ViewMode = "wt" | "all" | "claude";

const VIEW_MODE_CYCLE: ViewMode[] = ["wt", "all", "claude"];

const VIEW_MODE_ICON: Record<ViewMode, string> = {
  wt: "icon-[lucide--monitor]",
  all: "icon-[lucide--layout-grid]",
  claude: "icon-[lucide--bot]",
};

const VIEW_MODE_TITLE: Record<ViewMode, string> = {
  wt: "Active worktree",
  all: "All terminals",
  claude: "Claude terminals",
};

defineProps<{
  worktrees: WorktreeEntry[];
  /** worktree データ未取得（初回ロード中） */
  loading: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  ctrlPressed: boolean;
  now: number;
  viewMode: ViewMode;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
}>();

defineEmits<{
  select: [wt: WorktreeEntry];
  openMenu: [anchorName: string, wt: WorktreeEntry];
  add: [];
  setViewMode: [mode: ViewMode];
}>();

defineSlots<{
  "after-item"(props: { wt: WorktreeEntry }): unknown;
}>();
</script>

<template>
  <div class="mt-4 flex flex-col gap-1.5">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="text-xs font-medium text-zinc-500">WORKTREES</h2>
      <div class="flex gap-0.5">
        <button
          v-for="mode in VIEW_MODE_CYCLE"
          :key="mode"
          type="button"
          class="grid size-6 place-items-center rounded-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          :class="viewMode === mode && 'bg-zinc-700 text-zinc-200'"
          :title="VIEW_MODE_TITLE[mode]"
          :aria-label="VIEW_MODE_TITLE[mode]"
          :aria-pressed="viewMode === mode"
          @click="$emit('setViewMode', mode)"
        >
          <span class="text-sm" :class="VIEW_MODE_ICON[mode]" />
        </button>
      </div>
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
      class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
      :disabled="isCreating"
      @click="$emit('add')"
    >
      <span
        class="text-base"
        :class="isCreating ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--plus]'"
      />
      <span>New worktree</span>
    </button>
  </div>
</template>
