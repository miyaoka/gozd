<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- RPC 経由で `orkisOpen` イベントを受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- マウント時に `rendererReady` を送信してメインプロセスに準備完了を通知する
</doc>

<script setup lang="ts">
import { tryCatch } from "@orkis/shared";
import { onMounted, onUnmounted } from "vue";
import { useKeyBindings } from "./features/command/useKeyBindings";
import { useDiagnosticsStore } from "./features/diagnostics/useDiagnosticsStore";
import { useWorkspaceStore } from "./features/filer/useWorkspaceStore";
import MainLayout from "./features/layout/MainLayout.vue";
import { useRpc } from "./features/rpc/useRpc";

useKeyBindings();

const workspaceStore = useWorkspaceStore();
const diagnosticsStore = useDiagnosticsStore();
const { request, send, onOrkisOpen } = useRpc();

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onOrkisOpen(
    async ({ dir, selection, fileServerBaseUrl, channel, repoName, switchToDir }) => {
      if (switchToDir) {
        // 既存ウィンドウで別 worktree への切り替えが必要な場合
        const result = await tryCatch(request.switchDir({ dir: switchToDir }));
        if (result.ok) {
          diagnosticsStore.clear();
          workspaceStore.setOpen(
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
        workspaceStore.setOpen(dir, selection, fileServerBaseUrl, channel, repoName);
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
