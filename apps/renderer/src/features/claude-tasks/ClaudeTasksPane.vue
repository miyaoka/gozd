<script setup lang="ts">
import { computed } from "vue";
import { openSession } from "../session";
import { type LiveSession, useTerminalStore } from "../terminal";
import ClaudeTaskSessionRow from "./ClaudeTaskSessionRow.vue";
import type { ClaudeTaskList } from "./claudeTaskList";
import { useClaudeTasksStore } from "./useClaudeTasksStore";

const terminalStore = useTerminalStore();
const tasksStore = useClaudeTasksStore();

/**
 * タスクを持つ生きたセッション。端末を作った新しい順に出し、選択や状態の変化で並べ替えない。
 * 並びが動くと、押そうとした行が押す前に別の位置へ逃げる
 */
const rows = computed(() => {
  const result: { session: LiveSession; list: ClaudeTaskList }[] = [];
  for (const session of terminalStore.liveSessions) {
    const list = tasksStore.listsBySessionId[session.sessionId];
    if (list === undefined || list.tasks.length === 0) continue;
    result.push({ session, list });
  }
  // liveSessions は端末を作った古い順
  return result.toReversed();
});
</script>

<template>
  <div class="flex size-full flex-col gap-1 overflow-y-auto bg-background p-2 text-foreground">
    <ClaudeTaskSessionRow
      v-for="row in rows"
      :key="row.session.sessionId"
      :session="row.session"
      :list="row.list"
      :focused="row.session.sessionId === tasksStore.focusedSessionId"
      @select="openSession(row.session.dir, row.session.sessionId)"
    />
    <p v-if="rows.length === 0" class="px-1 text-xs text-foreground-low">
      No Claude session has tasks yet.
    </p>
  </div>
</template>
