<doc lang="md">
開発用デバッグ情報パネル。

## 表示内容

- 現在のモード（dev / build）とチャンネル（dev / stable）
- 開いているディレクトリ・ファイル
- git status（staged / unstaged）を変更種別ごとに色分けして一覧表示
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";
import { useAppStore } from "../../shared/app";
import { resolveGitChangeKind, useGitStatusStore, useWorktreeStore } from "../worktree";
import type { GitChangeKind } from "../worktree";

const props = defineProps<{
  explorerOpen: boolean;
  layoutDebug?: {
    terminalWidth: number;
    explorerWidth: number;
    previewWidth: number;
    windowWidth: number;
  };
}>();

const mode = import.meta.env.DEV ? "dev" : "build";
const worktreeStore = useWorktreeStore();
const appStore = useAppStore();
const { dir, selectedPath } = storeToRefs(worktreeStore);
const { channel } = storeToRefs(appStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);

const GIT_CHANGE_COLOR_MAP: Record<GitChangeKind, string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  untracked: "text-green-400",
  renamed: "text-blue-400",
};

interface GitStatusEntry {
  filePath: string;
  status: string;
  changeKind: GitChangeKind;
}

/** index 側（X）にステータスがあれば staged */
function isStaged(status: string): boolean {
  return status[0] !== " " && status[0] !== "?";
}

function toEntry(filePath: string, status: string): GitStatusEntry {
  return { filePath, status, changeKind: resolveGitChangeKind(status) };
}

const stagedEntries = computed<GitStatusEntry[]>(() =>
  Object.entries(gitStatuses.value)
    .filter(([, status]) => isStaged(status))
    .map(([filePath, status]) => toEntry(filePath, status)),
);

const unstagedEntries = computed<GitStatusEntry[]>(() =>
  Object.entries(gitStatuses.value)
    .filter(([, status]) => !isStaged(status))
    .map(([filePath, status]) => toEntry(filePath, status)),
);
</script>

<template>
  <div
    class="size-full overflow-y-auto rounded-sm border border-zinc-700 bg-zinc-800 p-3 font-mono text-sm text-zinc-300"
  >
    <div class="mb-1 flex items-center gap-2 font-bold text-zinc-400">
      <span class="icon-[lucide--bug]" />
      Debug
      <span
        class="rounded-sm bg-zinc-700 px-1.5 py-0.5 text-xs"
        :class="mode === 'dev' ? 'text-green-400' : 'text-blue-400'"
      >
        {{ mode === "dev" ? "dev" : `build:${channel ?? "?"}` }}
      </span>
    </div>
    <template v-if="dir">
      <div>dir: {{ dir }}</div>
      <div v-if="selectedPath">file: {{ selectedPath }}</div>
      <div>explorer: {{ props.explorerOpen ? "open" : "closed" }}</div>
      <div
        v-if="props.layoutDebug"
        class="mt-1 border-t border-zinc-700 pt-1 text-xs text-zinc-500"
      >
        <div>window: {{ props.layoutDebug.windowWidth }}</div>
        <div>terminal: {{ props.layoutDebug.terminalWidth }}</div>
        <div>explorer: {{ props.layoutDebug.explorerWidth }} (ref)</div>
        <div>preview: {{ props.layoutDebug.previewWidth }}</div>
      </div>

      <!-- git status -->
      <div class="mt-2 border-t border-zinc-700 pt-2">
        <div
          v-if="stagedEntries.length === 0 && unstagedEntries.length === 0"
          class="text-zinc-500"
        >
          clean
        </div>
        <template v-else>
          <template v-if="stagedEntries.length > 0">
            <div class="mb-0.5 text-zinc-400">staged ({{ stagedEntries.length }})</div>
            <div
              v-for="entry in stagedEntries"
              :key="entry.filePath"
              class="truncate text-xs"
              :class="GIT_CHANGE_COLOR_MAP[entry.changeKind]"
            >
              <span class="text-zinc-500">{{ entry.status[0] }}</span>
              {{ entry.filePath }}
            </div>
          </template>
          <template v-if="unstagedEntries.length > 0">
            <div class="mt-1 mb-0.5 text-zinc-400">unstaged ({{ unstagedEntries.length }})</div>
            <div
              v-for="entry in unstagedEntries"
              :key="entry.filePath"
              class="truncate text-xs"
              :class="GIT_CHANGE_COLOR_MAP[entry.changeKind]"
            >
              <span class="text-zinc-500">{{ entry.status === "??" ? "?" : entry.status[1] }}</span>
              {{ entry.filePath }}
            </div>
          </template>
        </template>
      </div>
    </template>
    <div v-else class="text-zinc-500">waiting for open command...</div>
  </div>
</template>
