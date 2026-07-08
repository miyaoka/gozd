<doc lang="md">
revive picker の1行分。セッションの title・branch・ログサイズ・最終日時を並べる
(色分けは最終日時のみ = PR 行と同じ相対日時カラー)。title が空 (aiTitle を拾えなかった)
場合は branch を表示名にフォールバックする。
</doc>

<script setup lang="ts">
import type { ReviveSessionInfo } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeDate } from "../../formatRelativeDate";
import IconLucideGitBranch from "~icons/lucide/git-branch";

const props = defineProps<{
  session: ReviveSessionInfo;
}>();

// lastActivity は Unix ミリ秒。formatRelativeDate は ISO 文字列を取るので変換する
// (PR 行と同じ相対日時 + 色分けに揃える)。
const dateDisplay = computed(() =>
  formatRelativeDate(new Date(props.session.lastActivity).toISOString()),
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
