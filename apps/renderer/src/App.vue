<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useWorkspace } from "./features/filer/useWorkspace";
import MainLayout from "./features/layout/MainLayout.vue";

const { setOpen } = useWorkspace();

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = window.api.onOpen((dir, file) => {
    setOpen(dir, file);
  });
  window.api.notifyReady();
});

onUnmounted(() => {
  cleanup?.();
});
</script>

<template>
  <MainLayout />
</template>
