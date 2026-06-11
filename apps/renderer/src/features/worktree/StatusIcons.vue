<doc lang="md">
git status の変更種別をアイコン + 件数で表示する。
git graph の uncommitted 行、サイドバーの worktree 一覧で共通利用する。
</doc>

<script setup lang="ts">
import type { StatusIconEntry } from "./gitStatusUtils";

defineProps<{
  entries: StatusIconEntry[];
  /** アイコンサイズ（Tailwind クラス） */
  iconSize?: string;
}>();
</script>

<template>
  <span
    v-for="entry in entries"
    :key="entry.kind"
    class="flex shrink-0 items-center gap-0.5"
    :title="`${entry.kind}: ${entry.count}`"
  >
    <component :is="entry.icon" :class="[entry.color, iconSize ?? 'size-3.5']" />
    <span class="text-[10px] text-foreground-low">{{ entry.count }}</span>
  </span>
</template>
