<doc lang="md">
選択中の task のセッション概要を出す右ペイン。「依頼（最初の user メッセージ）」と
「現況（最後の assistant メッセージ）」の 2 点だけを出し、切り替えずに文脈を思い出せる
ようにする。全文が要るときは行を確定してセッション本体へ跳ぶ。

## sessionId を debounce する理由

矢印キーでの行送りのたびに RPC + fs watch の張り替えが走るのを防ぐ。選択が落ち着いてから
読みに行けば、リストの往復では取得が発生しない。
</doc>

<script setup lang="ts">
import { refDebounced } from "@vueuse/core";
import { computed } from "vue";
import { parseSessionLog, SessionLogMessageBody, useSessionLogLive } from "../session-log";
import type { TranscriptEvent } from "../session-log";
import type { DashboardRow } from "./collectDashboardRows";

const props = defineProps<{
  row: DashboardRow | undefined;
}>();

const sessionId = computed(() => {
  const id = props.row?.task.sessionId;
  return id === "" ? undefined : id;
});
const debouncedSessionId = refDebounced(sessionId, 150);

const { sessions, loading, notFound, errorMessage } = useSessionLogLive(debouncedSessionId);

const events = computed((): TranscriptEvent[] => {
  const main = sessions.value.find((s) => s.kind === "main");
  if (main === undefined) return [];
  return parseSessionLog(main.content).events;
});

const firstUser = computed(() => events.value.find((e) => e.kind === "user"));

const lastAssistant = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    const event = events.value[i];
    if (event.kind === "assistant") return event;
  }
  return undefined;
});

/** 一覧側の選択と debounce 済み取得がずれている間は loading 扱いにする */
const isStale = computed(() => sessionId.value !== debouncedSessionId.value);

const emptyMessage = computed((): string | undefined => {
  if (props.row === undefined) return "Select a task";
  if (sessionId.value === undefined) return "No session yet";
  if (isStale.value || loading.value) return "Loading...";
  if (errorMessage.value !== undefined) return "Failed to read session log";
  if (notFound.value) return "No session log yet";
  if (firstUser.value === undefined && lastAssistant.value === undefined) return "No messages";
  return undefined;
});
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
    <div
      v-if="emptyMessage"
      class="flex flex-1 items-center justify-center px-3 py-8 text-sm text-foreground-low"
    >
      {{ emptyMessage }}
    </div>
    <div v-else class="flex flex-col gap-2 p-3">
      <template v-if="firstUser">
        <h3 class="text-[10px] font-semibold tracking-wide text-foreground-muted uppercase">
          First prompt
        </h3>
        <div class="rounded-md bg-chat-outgoing">
          <SessionLogMessageBody kind="user" :text="firstUser.text" />
        </div>
      </template>
      <template v-if="lastAssistant">
        <h3 class="text-[10px] font-semibold tracking-wide text-foreground-muted uppercase">
          Last response
        </h3>
        <div class="rounded-md bg-chat-incoming">
          <SessionLogMessageBody kind="assistant" :text="lastAssistant.text" />
        </div>
      </template>
    </div>
  </div>
</template>
