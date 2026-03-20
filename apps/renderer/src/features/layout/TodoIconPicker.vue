<doc lang="md">
Todo の分類アイコンを選択する emoji ピッカー。トグル方式で再クリックすると解除される。
</doc>

<script setup lang="ts">
import { TODO_ICONS } from "@orkis/rpc";

const icon = defineModel<string>();

function toggle(emoji: string) {
  icon.value = icon.value === emoji ? undefined : emoji;
}
</script>

<template>
  <div class="mb-1 flex flex-wrap gap-0.5" role="group" aria-label="Todo icon">
    <button
      v-for="ic in TODO_ICONS"
      :key="ic.emoji"
      type="button"
      :title="ic.title"
      :aria-label="ic.title"
      :aria-pressed="icon === ic.emoji"
      class="rounded-sm px-1 py-0.5 text-sm hover:bg-zinc-700"
      :class="
        icon === ic.emoji ? 'bg-zinc-600 ring-1 ring-blue-500' : 'opacity-60 hover:opacity-100'
      "
      @click="toggle(ic.emoji)"
    >
      {{ ic.emoji }}
    </button>
  </div>
</template>
