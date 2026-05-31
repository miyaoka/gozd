<doc lang="md">
session log の tool イベント見出しに出す主要引数プレビュー。代表キー (command / file_path 等)
を優先順で 1 つ拾い、preview を computed で 1 回だけ算出する。preview が空なら何も描画しない。

SessionLogDialog のテンプレートで `toolArgPreview(input)` を v-if / :title / 本文の 3 箇所で
呼んでいた重複評価を、この子コンポーネント側の computed 1 回に集約する。
</doc>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  input: Record<string, unknown>;
}>();

/** 代表キーを優先順で拾う。最初に見つかった非空 string を preview にする。 */
const TOOL_PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url"];
const preview = computed<string | undefined>(() => {
  for (const key of TOOL_PRIMARY_KEYS) {
    const value = props.input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
});
</script>

<template>
  <span v-if="preview" class="min-w-0 truncate text-zinc-500" :title="preview">{{ preview }}</span>
</template>
