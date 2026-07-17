<doc lang="md">
チャットメッセージ 1 件の本文描画 (kind 別)。terminal preview の全文 popover と
undock されたフローティングウィンドウ (UndockedLogWindow) が共有する。

- user は素のテキストとして描画する (markdown 解釈しない。SessionLogTranscript と同じ規律)
- assistant は MarkdownBody + chat 配色への CSS var 上書き。`_markdown-body :deep(code)` が
  inline code を foreground に固定するため、CSS 変数 override では足りず scoped
  `:deep(code)` で specificity を持ち上げて chat-code 色にする。この非自明な回避策を
  consumer ごとに再掲しないことがこのコンポーネントの存在理由
- kind 別の背景 (bg-chat-incoming / bg-chat-outgoing) は持たない。スクロール面や角丸と
  一体で管理すべき装飾なので consumer 側の container が担う
</doc>

<script setup lang="ts">
import { MarkdownBody } from "../preview";

interface Props {
  kind: "user" | "assistant";
  text: string;
}

defineProps<Props>();
</script>

<template>
  <div
    v-if="kind === 'assistant'"
    class="_session-log-assistant px-3 py-2 text-chat-incoming-text [--color-foreground-low:var(--color-chat-incoming-text-low)] [--color-foreground:var(--color-chat-incoming-text)] [--md-code-bg:transparent]"
  >
    <MarkdownBody :content="text" />
  </div>
  <div v-else class="px-3 py-2 wrap-break-word whitespace-pre-wrap text-chat-outgoing-text">
    {{ text }}
  </div>
</template>

<style scoped>
._session-log-assistant :deep(code) {
  color: var(--color-chat-code);
}
</style>
