<doc lang="md">
main transcript の Agent / SendMessage / Workflow 行に出す「subagent を右ペインで開く」ボタン。

- `link` があれば開くボタンを出す
- `link` が無くても `toolName` が subagent に結べるはずの tool (`SUBAGENT_LINK_TOOL_NAMES`) なら、
  解決できなかったことを示す警告アイコンを出す (無表示だと「そもそも subagent に結べない tool
  だった」のか「結べるはずが解決できなかった」のか見分けが付かず、後者を握りつぶしてしまうため)
- それ以外の tool (Bash 等) では何も描画しない

summary 上に置かれるため、click は details トグルへ伝播させず open だけを発火する。
</doc>

<script setup lang="ts">
import { SUBAGENT_LINK_TOOL_NAMES, type SubagentLink } from "./sessionLogView";
import IconLucideGitFork from "~icons/lucide/git-fork";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";

const props = defineProps<{
  // 紐づく subagent。無ければボタン自体を出さない。
  link: SubagentLink | undefined;
  // クリック時に同期する時刻 (この tool 呼び出しの ts)。
  ts: string;
  // この tool 呼び出しの名前 (Agent / SendMessage / Workflow / Bash 等)。link 未解決時に
  // 「本来結べるはずの呼び出しだったか」を判定するのに使う。
  toolName: string;
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
    class="flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-medium text-warning-text"
    :title="`Open subagent: ${link.label}`"
    @click.stop.prevent="onClick"
  >
    <IconLucideGitFork class="size-3 shrink-0" />
    <span class="max-w-32 truncate">{{ link.label }}</span>
  </button>
  <IconLucideTriangleAlert
    v-else-if="SUBAGENT_LINK_TOOL_NAMES.has(toolName)"
    class="size-3 shrink-0 text-warning-text"
    title="Could not link this call to a subagent"
  />
</template>
