<script setup lang="ts">
import { computed } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useSessionLogViewer } from "../session-log";
import { forkSessionToWorktree } from "./forkSessionToWorktree";
import { useSessionMenu } from "./useSessionMenu";
import IconLucideGitFork from "~icons/lucide/git-fork";
import IconLucideScrollText from "~icons/lucide/scroll-text";

const { Popover, context, close } = useSessionMenu();
const { open: openSessionLog } = useSessionLogViewer();
const repoStore = useRepoStore();

// worktree を作れるのは git repo だけ（窓口と非 git の project は除く）
const canFork = computed(
  () => !!context.value && repoStore.repoAt(context.value.rootDir)?.isGitRepo === true,
);

function handleShowSessionLog() {
  if (!context.value) return;
  const { row } = context.value;
  close();
  openSessionLog(row.sessionId, row.title);
}

function handleFork() {
  if (!context.value) return;
  const { row, rootDir } = context.value;
  close();
  void forkSessionToWorktree(row, rootDir);
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
      <button
        v-if="canFork"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleFork"
      >
        <IconLucideGitFork class="text-xs" />
        Fork into new worktree
      </button>
    </template>
  </Popover>
</template>
