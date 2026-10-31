<script setup lang="ts">
import type { ReviveSessionInfo } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeAge } from "../../../../shared/time";
import IconLucideGitBranch from "~icons/lucide/git-branch";

const props = defineProps<{
  session: ReviveSessionInfo;
}>();

// lastActivity は Unix ミリ秒。相対日時は秒で扱う (PR 行と同じ表示に揃える)。
const dateDisplay = computed(() =>
  formatRelativeAge(Math.floor(props.session.lastActivity / 1000)),
);
const title = computed(() =>
  props.session.title !== "" ? props.session.title : props.session.branch,
);

const BYTES_PER_KB = 1024;
/** bytes を KB 固定の短縮表記にする (会話量の目安表示用途)。桁区切りは locale に委ねる。 */
function formatKB(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_KB).toLocaleString()} KB`;
}
const size = computed(() => formatKB(props.session.sizeBytes));
</script>

<template>
  <span class="truncate">{{ title }}</span>
  <span class="flex items-center gap-1 truncate text-primary-text">
    <IconLucideGitBranch class="size-3.5 shrink-0" />
    <span class="truncate">{{ session.branch }}</span>
  </span>
  <span class="truncate text-right text-foreground-low tabular-nums">{{ size }}</span>
  <span class="truncate text-right" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
</template>
