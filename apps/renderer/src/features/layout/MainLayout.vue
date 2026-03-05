<script setup lang="ts">
import TerminalPane from "../terminal/TerminalPane.vue";
import SidebarPane from "./SidebarPane.vue";
</script>

<template>
  <div class="flex h-screen bg-zinc-900 text-white">
    <SidebarPane />
    <div class="min-w-0 flex-1 p-2">
      <TerminalPane />
    </div>
  </div>
</template>
