<script setup lang="ts">
import { useWorkspace } from "../filer/useWorkspace";

const mode = import.meta.env.DEV ? "dev" : "build";
const { dir, file } = useWorkspace();
</script>

<template>
  <div class="rounded-sm border border-zinc-700 bg-zinc-800 p-3 font-mono text-sm text-zinc-300">
    <div class="mb-1 flex items-center gap-2 font-bold text-zinc-400">
      <span class="icon-[lucide--bug]" />
      Debug
      <span
        v-if="mode"
        class="rounded-sm bg-zinc-700 px-1.5 py-0.5 text-xs"
        :class="mode === 'dev' ? 'text-green-400' : 'text-blue-400'"
      >
        {{ mode }}
      </span>
    </div>
    <template v-if="dir">
      <div>dir: {{ dir }}</div>
      <div v-if="file">file: {{ file }}</div>
    </template>
    <div v-else class="text-zinc-500">waiting for open command...</div>
  </div>
</template>
