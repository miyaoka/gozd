<doc lang="md">
Git Graph ツールバーの小さなトグルボタン。active 状態で塗り、非 active では地味色 + hover。
</doc>

<script setup lang="ts">
defineProps<{
  /** トグルが ON か。塗り分けと aria-pressed に使う */
  active: boolean;
  title?: string;
}>();
</script>

<template>
  <button
    type="button"
    class="rounded-sm px-1.5 py-0.5 text-[10px]"
    :class="
      active ? 'bg-primary-subtle text-primary-text' : 'text-foreground-low hover:text-foreground'
    "
    :aria-pressed="active"
    :title="title"
  >
    <slot />
  </button>
</template>
