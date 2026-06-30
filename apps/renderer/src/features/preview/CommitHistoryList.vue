<doc lang="md">
コミット履歴の一覧を描画する presentational コンポーネント。

行 history (BlamePopover) とファイル history (FileHistoryPopover) で共有する。
描画のみを担い、commit クリックは `select` emit で親へ委譲する (git-graph 選択等の
副作用は親側に置く)。
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/proto";
import { formatAbsoluteTime, formatRelativeTime } from "../../shared/time";

defineProps<{
  commits: GitCommit[];
}>();

const emit = defineEmits<{
  select: [hash: string];
}>();
</script>

<template>
  <ul class="divide-y divide-border-subtle">
    <li v-for="c in commits" :key="c.hash">
      <button
        type="button"
        class="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-panel"
        @click="emit('select', c.hash)"
      >
        <span
          class="mt-0.5 shrink-0 rounded-sm bg-panel px-1.5 py-0.5 font-mono text-[11px] text-foreground"
          >{{ c.shortHash }}</span
        >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-foreground">{{ c.message }}</span>
          <span class="mt-0.5 flex items-center gap-2 text-[11px] text-foreground-low">
            <span class="truncate">{{ c.author }}</span>
            <span :title="formatAbsoluteTime(Number(c.date))">{{
              formatRelativeTime(Number(c.date))
            }}</span>
          </span>
        </span>
      </button>
    </li>
  </ul>
</template>
