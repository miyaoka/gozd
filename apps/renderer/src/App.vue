<script setup lang="ts">
const ipcHandle = () => window.api.ping();
</script>

<template>
  <div class="flex h-screen flex-col items-center justify-center gap-4 bg-zinc-900 text-white">
    <span class="icon-[lucide--bot] size-12 text-blue-400" />
    <h1 class="text-3xl font-bold">orkis</h1>
    <p class="text-zinc-400">AI Agent Orchestrator</p>
    <button class="rounded-sm bg-blue-600 px-4 py-2 hover:bg-blue-500" @click="ipcHandle">
      Send IPC ping
    </button>
  </div>
</template>
