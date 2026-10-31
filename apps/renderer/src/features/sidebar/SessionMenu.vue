<script setup lang="ts">
import { useSessionLogViewer } from "../session-log";
import { useSessionMenu } from "./useSessionMenu";
import IconLucideScrollText from "~icons/lucide/scroll-text";

const { Popover, context, close } = useSessionMenu();
const { open: openSessionLog } = useSessionLogViewer();

function handleShowSessionLog() {
  if (!context.value) return;
  const { row } = context.value;
  close();
  openSessionLog(row.sessionId, row.title);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleShowSessionLog"
      >
        <IconLucideScrollText class="text-xs" />
        Show session log
      </button>
    </template>
  </Popover>
</template>
