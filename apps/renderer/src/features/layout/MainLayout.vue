<script setup lang="ts">
import DebugPane from "../debug/DebugPane.vue";
import FilerPane from "../filer/FilerPane.vue";
import TerminalPane from "../terminal/TerminalPane.vue";
import SidebarPane from "./SidebarPane.vue";
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-zinc-900 text-white">
    <div class="flex min-h-0 flex-1">
      <SidebarPane />
      <FilerPane />
      <div class="min-w-0 flex-1 p-2">
        <TerminalPane />
      </div>
    </div>
    <DebugPane />
  </div>
</template>
