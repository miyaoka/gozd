<doc lang="md">
main transcript の Agent / SendMessage 行に出す「subagent を右ペインで開く」ボタン。
`link` が無い tool 呼び出し (subagent に結べないもの) では何も描画しない。
summary 上に置かれるため、click は details トグルへ伝播させず open だけを発火する。
</doc>

<script setup lang="ts">
import type { SubagentLink } from "./sessionLog";

const props = defineProps<{
  // 紐づく subagent。無ければボタン自体を出さない。
  link: SubagentLink | undefined;
  // クリック時に同期する時刻 (この tool 呼び出しの ts)。
  ts: string;
}>();

const emit = defineEmits<{
  (e: "open", payload: { agentId: string; ts: string }): void;
}>();

function onClick() {
  if (props.link === undefined) return;
  emit("open", { agentId: props.link.agentId, ts: props.ts });
}
</script>

<template>
  <button
    v-if="link"
    type="button"
    class="flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-medium text-warning-text transition-colors"
    :title="`Open subagent: ${link.label}`"
    @click.stop.prevent="onClick"
  >
    <span class="icon-[lucide--git-fork] size-3 shrink-0" />
    <span class="max-w-32 truncate">{{ link.label }}</span>
  </button>
</template>
