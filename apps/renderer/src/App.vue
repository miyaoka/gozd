<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- RPC 経由で `gozdOpen` イベントを受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- マウント時に `rendererReady` を送信してメインプロセスに準備完了を通知する
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { MainLayout } from "./features/layout";
import { useWorktreeStore } from "./features/worktree";
import { useAppStore } from "./shared/app";
import { useContextKeys, useKeyBindings } from "./shared/command";
import { useProjectStore } from "./shared/project";
import { useRpc } from "./shared/rpc";

useKeyBindings();

const worktreeStore = useWorktreeStore();
const appStore = useAppStore();
const projectStore = useProjectStore();
const contextKeys = useContextKeys();
const { request, send, onGozdOpen, onErrorNotify } = useRpc();

const disposeErrorNotify = onErrorNotify(({ source, message, detail }) => {
  console.error(`[${source}]`, message, ...(detail ? [detail] : []));
});

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onGozdOpen(
    async ({ dir, selection, fileServerBaseUrl, channel, repoName, isGitRepo, switchToDir }) => {
      if (channel) {
        appStore.setChannel(channel);
      }
      projectStore.setProject(repoName, isGitRepo);
      contextKeys.set("isGitRepo", isGitRepo);
      if (switchToDir) {
        // 既存ウィンドウで別 worktree への切り替えが必要な場合
        const result = await tryCatch(request.switchDir({ dir: switchToDir }));
        if (result.ok) {
          worktreeStore.setOpen(result.value.dir, selection, result.value.fileServerBaseUrl);
        } else {
          console.error("Failed to switch worktree:", switchToDir, result.error);
        }
      } else {
        worktreeStore.setOpen(dir, selection, fileServerBaseUrl);
      }
    },
  );
  send.rendererReady();
});

onUnmounted(() => {
  cleanup?.();
  disposeErrorNotify();
});
</script>

<template>
  <MainLayout />
</template>
