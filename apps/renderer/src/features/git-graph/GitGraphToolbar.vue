<script setup lang="ts">
import type { BranchScope, SortMode } from "@gozd/rpc";
import ToggleChip from "./ToggleChip.vue";
import IconLucideGitBranch from "~icons/lucide/git-branch";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";
import IconLucidePanelRight from "~icons/lucide/panel-right";

defineProps<{
  /** git log で取得した commit 件数 (0 のとき件数表示を隠す) */
  commitCount: number;
}>();

const firstParentOnly = defineModel<boolean>("firstParentOnly", { required: true });
const branchScope = defineModel<BranchScope>("branchScope", { required: true });
const sortMode = defineModel<SortMode>("sortMode", { required: true });
const detailOpen = defineModel<boolean>("detailOpen", { required: true });

// segment の並び順は範囲の狭い順 (current → default → all)。label は各ボタンに表示する scope 名、
// title は hover 時の補足説明。
const BRANCH_SCOPE_SEGMENTS: { scope: BranchScope; label: string; title: string }[] = [
  { scope: "current", label: "Current", title: "Show current branch (HEAD) only" },
  { scope: "default", label: "Default", title: "Show current + default branch" },
  { scope: "all", label: "All", title: "Show all local and remote branches" },
];

function toggleSortMode() {
  sortMode.value = sortMode.value === "date" ? "topo" : "date";
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
    <IconLucideGitCommitHorizontal class="size-4 text-foreground-low" />
    <span class="text-xs font-semibold text-foreground-low">Git Graph</span>
    <span v-if="commitCount > 0" class="text-xs text-foreground-low">({{ commitCount }})</span>
    <ToggleChip
      :active="firstParentOnly"
      title="Show first-parent history only"
      @click="firstParentOnly = !firstParentOnly"
    >
      First Parent
    </ToggleChip>
    <div class="flex items-center gap-1">
      <IconLucideGitBranch class="size-3 text-foreground-low" />
      <div
        role="group"
        aria-label="Branch scope"
        class="flex items-center gap-0.5 rounded-sm bg-element p-0.5"
      >
        <button
          v-for="segment in BRANCH_SCOPE_SEGMENTS"
          :key="segment.scope"
          type="button"
          :aria-pressed="branchScope === segment.scope"
          :title="segment.title"
          class="rounded-xs px-1.5 py-0.5 text-[10px] transition-colors"
          :class="
            branchScope === segment.scope
              ? 'bg-primary-subtle text-primary-text'
              : 'text-foreground-low hover:text-foreground'
          "
          @click="branchScope = segment.scope"
        >
          {{ segment.label }}
        </button>
      </div>
    </div>
    <ToggleChip :active="sortMode === 'topo'" @click="toggleSortMode">
      {{ sortMode === "date" ? "Date Order" : "Topo Order" }}
    </ToggleChip>
    <ToggleChip
      class="ml-auto"
      :active="detailOpen"
      title="Toggle commit detail"
      aria-label="Toggle commit detail"
      @click="detailOpen = !detailOpen"
    >
      <IconLucidePanelRight class="size-3.5" />
    </ToggleChip>
  </div>
</template>
