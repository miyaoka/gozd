<script setup lang="ts">
import DebugPane from "../debug/DebugPane.vue";
import TerminalPane from "../terminal/TerminalPane.vue";
import SidebarPane from "./SidebarPane.vue";
</script>

<template>
  <div class="flex h-screen bg-zinc-900 text-white">
    <SidebarPane />
    <div class="flex min-w-0 flex-1 flex-col gap-2 p-2">
      <DebugPane />
      <TerminalPane />
    </div>
  </div>
</template>
