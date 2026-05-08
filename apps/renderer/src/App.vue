<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- Swift → renderer の `gozdOpen` push を受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- `notify` push を受信してトースト表示する
</doc>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { MainLayout } from "./features/layout";
import { useWorktreeStore } from "./features/worktree";
import { useAppStore } from "./shared/app";
import { useCommandRegistry, useContextKeys, useKeyBindings } from "./shared/command";
import { useNotificationStore } from "./shared/notification";
import { useProjectStore } from "./shared/project";
import { onMessage } from "./shared/rpc";

interface GozdOpenPayload {
  dir: string;
  selection?: { kind: string; relPath: string; lineNumber: number };
  channel: string;
  repoName: string;
  isGitRepo: boolean;
  switchToDir: string;
}

interface NotifyPayload {
  type: "error" | "info";
  source: string;
  message: string;
  detail: string;
}

useKeyBindings();

const worktreeStore = useWorktreeStore();
const appStore = useAppStore();
const projectStore = useProjectStore();
const contextKeys = useContextKeys();
const notify = useNotificationStore();
const { setErrorHandler } = useCommandRegistry();
setErrorHandler(notify.error);

const disposeNotify = onMessage<NotifyPayload>("notify", ({ type, source, message, detail }) => {
  const notifyFn = type === "error" ? notify.error : notify.info;
  notifyFn(`[${source}] ${message}`, detail);
});

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage<GozdOpenPayload>(
    "gozdOpen",
    ({ dir, selection, channel, repoName, isGitRepo, switchToDir }) => {
      if (channel) {
        appStore.setChannel(channel);
      }
      projectStore.setProject(repoName, isGitRepo);
      contextKeys.set("isGitRepo", isGitRepo);
      // ステートレス化（issue #310）により switchDir RPC は廃止。renderer 側で dir を直接切替
      const targetDir = switchToDir !== "" ? switchToDir : dir;
      // proto3 scalar では undefined が表現できないため、空 selection は未指定として扱う
      const sel = selection !== undefined && selection.relPath !== "" ? selection : undefined;
      worktreeStore.setOpen(targetDir, sel, undefined);
    },
  );
});

onUnmounted(() => {
  cleanup?.();
  disposeNotify();
});
</script>

<template>
  <MainLayout />
</template>
