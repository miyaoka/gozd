<doc lang="md">
Git Graph のヘッダーツールバー。表示オプション (first-parent / branch scope / sort order) の
トグルと詳細ペイン開閉を扱う。状態はすべて v-model で親が所有する。

## branch scope の segmented control

始点 ref 範囲は current / default / all の 3 排他値。トグル (2 状態 / aria-pressed) では表せないため
segmented control にする。track (凹んだ `bg-element` コンテナ) の中で選択セグメントだけを thumb として
塗り、3 ボタンが 1 つの塊に見える形にする (iOS / Primer 等 2026 の主流パターン)。選択色は同ツールバーの
ToggleChip の "on" 状態 (`bg-primary-subtle`) と揃え、ツールバー内で「選択 = primary tint」を一貫させる。
`role="group"` + group label でグループを、`aria-pressed` で選択状態を SR に伝える (SidebarPane の
viewMode と同じ排他選択 idiom)。all はローカル / リモート全ブランチを walk するため、遠い分岐が多い
repo では列幅と描画コストが増える (取得はローカル walk のみでネットワークは発生しない)。
</doc>

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
