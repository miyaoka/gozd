<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- Swift → renderer の `gozdOpen` push を受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- `notify` push を受信してトースト表示する
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { rpcFsUnwatch, rpcFsWatch } from "./features/filer";
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

// worktreeStore.dir の変更に追従して FSWatchRegistry の対象 dir を切り替える。
// 旧 dir は unwatch、新 dir は watch することで、サーバー側の FSWatcher を
// 現在表示中の worktree に同期させる（fsChange / gitStatusChange 等の push が届く）。
const stopWatchDir = watch(
  () => worktreeStore.dir,
  async (newDir, oldDir) => {
    if (oldDir !== undefined && oldDir !== newDir) {
      await tryCatch(rpcFsUnwatch({ dir: oldDir }));
    }
    if (newDir !== undefined && newDir !== oldDir) {
      const result = await tryCatch(rpcFsWatch({ dir: newDir }));
      if (!result.ok) {
        notify.error("Failed to start FS watch", result.error);
      }
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  cleanup?.();
  disposeNotify();
  stopWatchDir();
  if (worktreeStore.dir !== undefined) {
    void tryCatch(rpcFsUnwatch({ dir: worktreeStore.dir }));
  }
});
</script>

<template>
  <MainLayout />
</template>
