<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useWorkspace } from "./features/filer/useWorkspace";
import MainLayout from "./features/layout/MainLayout.vue";
import { useRpc } from "./features/rpc/useRpc";

const { setOpen } = useWorkspace();
const { send, onOrkisOpen } = useRpc();

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onOrkisOpen(({ dir, file }) => {
    setOpen(dir, file);
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
