<doc lang="md">
サイドバーのツールバーの直下に固定する窓口の行（docs/concierge.md）。repo list の外に置き、list の
切り替えや編集モードの影響を受けない。

見た目は非 git project の RepoSection に揃える。ヘッダのクリックは窓口を選ぶだけで、Claude は起動しない。
下に窓口のセッションを並べる。窓口のセッションは毎回新しく始めるもので、過去のものは
必要なときだけ選んで再開するため、並びと畳み方は他の project のセッション行と同じにする。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { buildSessionRows, type SessionRow } from "../../../session";
import { activateDir, useTerminalStore } from "../../../terminal";
import { SessionList } from "../worktree";
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
  return buildSessionRows(dir, terminalStore.liveSessions, repoStore.sessionsOf(dir));
});
const hasSessions = computed(
  () => sessionRows.value.live.length > 0 || sessionRows.value.inactive.length > 0,
);

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
