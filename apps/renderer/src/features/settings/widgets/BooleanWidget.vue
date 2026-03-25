<doc lang="md">
boolean 設定用トグルスイッチ。
</doc>

<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
    :class="model ? 'bg-blue-500' : 'bg-zinc-600'"
    @click="model = !model"
  >
    <span
      class="pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform"
      :class="model ? 'translate-x-[18px]' : 'translate-x-0.5'"
      :style="{ marginTop: '2px' }"
    />
  </button>
</template>
