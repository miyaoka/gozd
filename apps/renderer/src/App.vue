<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- RPC 経由で `gozdOpen` イベントを受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- マウント時に `rendererReady` を送信してメインプロセスに準備完了を通知する
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { useDiagnosticsStore } from "./features/diagnostics";
import { MainLayout } from "./features/layout";
import { useWorktreeStore } from "./features/worktree";
import { useKeyBindings } from "./shared/command";
import { useRpc } from "./shared/rpc";

useKeyBindings();

const worktreeStore = useWorktreeStore();
const diagnosticsStore = useDiagnosticsStore();
const { request, send, onGozdOpen } = useRpc();

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onGozdOpen(
    async ({ dir, selection, fileServerBaseUrl, channel, repoName, switchToDir }) => {
      if (switchToDir) {
        // 既存ウィンドウで別 worktree への切り替えが必要な場合
        const result = await tryCatch(request.switchDir({ dir: switchToDir }));
        if (result.ok) {
          diagnosticsStore.clear();
          worktreeStore.setOpen(
            result.value.dir,
            selection,
            result.value.fileServerBaseUrl,
            channel,
            repoName,
          );
        } else {
          console.error("Failed to switch worktree:", switchToDir, result.error);
        }
      } else {
        worktreeStore.setOpen(dir, selection, fileServerBaseUrl, channel, repoName);
      }
    },
  );
  send.rendererReady();
});

onUnmounted(() => {
  cleanup?.();
});
</script>

<template>
  <MainLayout />
</template>
