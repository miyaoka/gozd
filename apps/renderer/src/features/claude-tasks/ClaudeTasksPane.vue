<script setup lang="ts">
import { computed } from "vue";
import { openSession } from "../session";
import { displayClaudeState, type LiveSession, useTerminalStore } from "../terminal";
import ClaudeTaskSessionRow from "./ClaudeTaskSessionRow.vue";
import ClaudeTaskSteps from "./ClaudeTaskSteps.vue";
import { attentionRank, type ClaudeTaskList } from "./claudeTaskList";
import { useClaudeTasksStore } from "./useClaudeTasksStore";

const terminalStore = useTerminalStore();
const tasksStore = useClaudeTasksStore();

const focusedList = computed(() => tasksStore.focusedList);

const emptyMessage = computed(() =>
  tasksStore.focusedSessionId === undefined
    ? "Focus a terminal running Claude to see its tasks."
    : "No tasks in this session yet.",
);

/** フォーカス中のほかの、タスクを持つ生きたセッション。対応が要るものから並べる */
const otherSessions = computed(() => {
  const rows: { session: LiveSession; list: ClaudeTaskList }[] = [];
  for (const session of terminalStore.liveSessions) {
    if (session.sessionId === tasksStore.focusedSessionId) continue;
    const list = tasksStore.listsBySessionId[session.sessionId];
    if (list === undefined || list.tasks.length === 0) continue;
    rows.push({ session, list });
  }
  const rank = (row: (typeof rows)[number]) =>
    attentionRank(row.list, displayClaudeState(row.session.status) === "asking");
  return rows.toSorted((a, b) => rank(a) - rank(b));
});
</script>

<template>
  <div class="flex size-full flex-col gap-3 overflow-y-auto bg-background p-2 text-foreground">
    <ClaudeTaskSteps v-if="focusedList.tasks.length > 0" :list="focusedList" />
    <p v-else class="px-1 text-xs text-foreground-low">{{ emptyMessage }}</p>

    <section v-if="otherSessions.length > 0" class="flex flex-col gap-1">
      <h3 class="px-1 text-xs font-semibold text-foreground-low">Other sessions</h3>
      <ClaudeTaskSessionRow
        v-for="row in otherSessions"
        :key="row.session.sessionId"
        :session="row.session"
        :list="row.list"
        @select="openSession(row.session.dir, row.session.sessionId)"
      />
    </section>
  </div>
</template>
