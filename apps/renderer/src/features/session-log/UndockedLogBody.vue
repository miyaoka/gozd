<doc lang="md">
undock されたセッションログの本文スクロール面 (kind 別配色)。

in-app パネルと昇格後の OS ウィンドウの両 presentation から同じ本文を描くために切り出している
(UndockedLogHeader と同じ理由。配色や scroll 方針が presentation でずれないよう SSOT を 1 つに
保つ)。`min-h-0 flex-1` は「本文が scroll container になる」UndockedWindow の契約。
</doc>

<script setup lang="ts">
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import type { UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

defineProps<Props>();
</script>

<template>
  <div
    class="min-h-0 flex-1 overflow-auto select-text"
    :class="log.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
  >
    <SessionLogMessageBody :kind="log.kind" :text="log.text" />
  </div>
</template>
