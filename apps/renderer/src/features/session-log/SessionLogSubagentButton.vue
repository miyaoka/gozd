<script setup lang="ts">
import type { SubagentLinkResult } from "./sessionLogView";
import IconLucideGitFork from "~icons/lucide/git-fork";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";

const props = defineProps<{
  // 紐づく subagent の解決結果。undefined ならそもそも紐付け対象外の tool。
  result: SubagentLinkResult | undefined;
  // クリック時に同期する時刻 (この tool 呼び出しの ts)。
  ts: string;
}>();

const emit = defineEmits<{
  (e: "open", payload: { agentId: string; ts: string }): void;
}>();

function onClick() {
  if (props.result?.status !== "resolved") return;
  emit("open", { agentId: props.result.agentId, ts: props.ts });
}
</script>

<template>
  <button
    v-if="result?.status === 'resolved'"
    type="button"
    class="flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-medium text-warning-text"
    :title="`Open subagent: ${result.label}`"
    @click.stop.prevent="onClick"
  >
    <IconLucideGitFork class="size-3 shrink-0" />
    <span class="max-w-32 truncate">{{ result.label }}</span>
  </button>
  <IconLucideTriangleAlert
    v-else-if="result?.status === 'unresolved'"
    class="size-3 shrink-0 text-warning-text"
    title="Could not link this call to a subagent"
  />
</template>
