<script setup lang="ts">
import { computed } from "vue";
import { formatRelativeAge } from "../../shared/time";
import { RepoIcon } from "../repo-icon";
import type { PoolSessionRow } from "../session";
import { claudeStateGlyph } from "../terminal";
import { WorktreeLabel } from "../worktree";

const props = defineProps<{
  row: PoolSessionRow;
}>();

const visual = computed(() => claudeStateGlyph(props.row.status));

const age = computed(() => {
  const lastActivity = props.row.lastActivity;
  return lastActivity === undefined
    ? undefined
    : formatRelativeAge(Math.floor(lastActivity / 1000));
});
</script>

<template>
  <!-- col-start-2: 先頭の gutter トラックを飛ばして配置する (カラム定義は DashboardDialog) -->
  <span class="col-start-2 grid place-items-center">
    <component
      :is="visual.icon"
      class="size-4"
      :class="visual.class"
      role="img"
      :aria-label="visual.ariaLabel"
    />
  </span>
  <span class="truncate">{{ row.title }}</span>
  <span class="flex items-center gap-1.5 truncate">
    <RepoIcon :name="row.repoName" :owner="row.owner" />
    <span class="truncate text-foreground-low">{{ row.repoName }}</span>
  </span>
  <span class="min-w-0 text-primary-text">
    <WorktreeLabel v-if="row.worktree" :wt="row.worktree" />
  </span>
  <span v-if="age" class="truncate text-right tabular-nums" :class="age.color">{{ age.text }}</span>
  <span v-else></span>
</template>
