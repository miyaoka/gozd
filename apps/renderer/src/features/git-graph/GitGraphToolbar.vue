<doc lang="md">
Git Graph のヘッダーツールバー。表示オプション (first-parent / current-branch / sort order) の
トグルと、HEAD へのスクロール要求・詳細ペイン開閉を扱う。状態はすべて v-model / emit で親が所有する。
</doc>

<script setup lang="ts">
import { SortMode } from "@gozd/proto";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";
import IconLucidePanelRight from "~icons/lucide/panel-right";

defineProps<{
  /** git log で取得した commit 件数 (0 のとき件数表示を隠す) */
  commitCount: number;
}>();

const firstParentOnly = defineModel<boolean>("firstParentOnly", { required: true });
const currentBranchOnly = defineModel<boolean>("currentBranchOnly", { required: true });
const sortMode = defineModel<SortMode>("sortMode", { required: true });
const detailOpen = defineModel<boolean>("detailOpen", { required: true });

const emit = defineEmits<{
  scrollToHead: [];
}>();

function toggleSortMode() {
  sortMode.value =
    sortMode.value === SortMode.SORT_MODE_DATE ? SortMode.SORT_MODE_TOPO : SortMode.SORT_MODE_DATE;
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
    <IconLucideGitCommitHorizontal class="size-4 text-foreground-low" />
    <span class="text-xs font-semibold text-foreground-low">Git Graph</span>
    <span v-if="commitCount > 0" class="text-xs text-foreground-low">({{ commitCount }})</span>
    <button
      class="rounded-sm px-1.5 py-0.5 text-[10px]"
      :class="
        firstParentOnly
          ? 'bg-primary-subtle text-primary-text'
          : 'text-foreground-low hover:text-foreground'
      "
      :aria-pressed="firstParentOnly"
      @click="firstParentOnly = !firstParentOnly"
    >
      First Parent
    </button>
    <button
      class="rounded-sm px-1.5 py-0.5 text-[10px]"
      :class="
        currentBranchOnly
          ? 'bg-primary-subtle text-primary-text'
          : 'text-foreground-low hover:text-foreground'
      "
      :aria-pressed="currentBranchOnly"
      title="Hide default branch and show current branch only"
      @click="currentBranchOnly = !currentBranchOnly"
    >
      Current Branch
    </button>
    <button
      class="rounded-sm px-1.5 py-0.5 text-[10px]"
      :class="
        sortMode === SortMode.SORT_MODE_TOPO
          ? 'bg-primary-subtle text-primary-text'
          : 'text-foreground-low hover:text-foreground'
      "
      :aria-pressed="sortMode === SortMode.SORT_MODE_TOPO"
      @click="toggleSortMode"
    >
      {{ sortMode === SortMode.SORT_MODE_DATE ? "Date Order" : "Topo Order" }}
    </button>
    <button
      class="rounded-sm px-1.5 py-0.5 text-[10px] text-foreground-low hover:text-foreground"
      @click="emit('scrollToHead')"
    >
      Scroll to HEAD
    </button>
    <button
      class="ml-auto rounded-sm px-1.5 py-0.5 text-[10px]"
      :class="
        detailOpen
          ? 'bg-primary-subtle text-primary-text'
          : 'text-foreground-low hover:text-foreground'
      "
      :aria-pressed="detailOpen"
      title="Toggle commit detail"
      aria-label="Toggle commit detail"
      @click="detailOpen = !detailOpen"
    >
      <IconLucidePanelRight class="size-3.5" />
    </button>
  </div>
</template>
