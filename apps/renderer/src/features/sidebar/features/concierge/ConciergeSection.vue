<script setup lang="ts">
import { computed } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { buildSessionRows, type SessionRow } from "../../../session";
import { activateDir, useTerminalStore } from "../../../terminal";
import { hasSessionRows, SessionList, visibleSessionRows } from "../session-row";
import IconLucideConciergeBell from "~icons/lucide/concierge-bell";

const props = defineProps<{
  activeDir: string | undefined;
}>();

const emit = defineEmits<{
  selectSession: [row: SessionRow];
  openSessionMenu: [anchorEl: HTMLElement, row: SessionRow, rootDir: string];
}>();

const repoStore = useRepoStore();
const terminalStore = useTerminalStore();

const concierge = computed(() => repoStore.concierge);
const active = computed(
  () => concierge.value !== undefined && props.activeDir === concierge.value.rootDir,
);

const sessionRows = computed(() => {
  const dir = concierge.value?.rootDir;
  if (dir === undefined) return { live: [], inactive: [] };
  return visibleSessionRows(
    buildSessionRows(dir, terminalStore.liveSessions, repoStore.sessionsOf(dir)),
    active.value,
  );
});
const hasSessions = computed(() => hasSessionRows(sessionRows.value));

function onHeaderClick() {
  if (concierge.value === undefined) return;
  activateDir(concierge.value.rootDir);
}

function onOpenSessionMenu(anchorEl: HTMLElement, row: SessionRow) {
  if (concierge.value === undefined) return;
  emit("openSessionMenu", anchorEl, row, concierge.value.rootDir);
}
</script>

<template>
  <section
    v-if="concierge"
    :data-active="active"
    :data-wt-path="concierge.rootDir"
    class="_fx-panel flex flex-col rounded-lg"
  >
    <header class="_fx-shine relative flex items-center rounded-lg text-foreground">
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
        :title="concierge.rootDir"
        aria-label="Open concierge"
        @click="onHeaderClick"
      >
        <IconLucideConciergeBell class="size-5 shrink-0 text-primary-text" />
        <span class="truncate text-sm font-semibold tracking-wide">{{ concierge.repoName }}</span>
      </button>
    </header>
    <div v-if="hasSessions" class="px-2 pb-2">
      <SessionList
        :rows="sessionRows"
        :dir="concierge.rootDir"
        :active="active"
        @select="(row) => emit('selectSession', row)"
        @open-menu="onOpenSessionMenu"
      />
    </div>
  </section>
</template>
