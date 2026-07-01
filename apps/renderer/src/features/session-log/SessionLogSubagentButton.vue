<doc lang="md">
main transcript の Agent / SendMessage / Workflow 行に出す「subagent を右ペインで開く」ボタン。

- `result` が `resolved` なら開くボタンを出す
- `result` が `unresolved` なら、解決できなかったことを示す警告アイコンを出す (無表示だと
  「そもそも subagent に結べない tool だった」のか「結べるはずが解決できなかった」のか見分けが
  付かず、後者を握りつぶしてしまうため)
- `result` が `undefined`（entry 自体が無い = Bash 等そもそも紐付け対象外の tool）では何も描画
  しない

「どの tool 名が紐付け対象か」の判定はすべて `buildSubagentLinks` 側に閉じており、このコンポーネント
は tool 名を一切知らない。summary 上に置かれるため、click は details トグルへ伝播させず open だけを
発火する。
</doc>

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
