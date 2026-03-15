<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- RPC 経由で `orkisOpen` イベントを受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- マウント時に `rendererReady` を送信してメインプロセスに準備完了を通知する
</doc>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useKeyBindings } from "./features/command/useKeyBindings";
import { useWorkspaceStore } from "./features/filer/useWorkspaceStore";
import MainLayout from "./features/layout/MainLayout.vue";
import { useRpc } from "./features/rpc/useRpc";

useKeyBindings();

const workspaceStore = useWorkspaceStore();
const { send, onOrkisOpen } = useRpc();

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onOrkisOpen(({ dir, file, fileServerBaseUrl, channel }) => {
    workspaceStore.setOpen(dir, file, fileServerBaseUrl, channel);
  });
  send.rendererReady();
});

onUnmounted(() => {
  cleanup?.();
});
</script>

<template>
  <MainLayout />
</template>
