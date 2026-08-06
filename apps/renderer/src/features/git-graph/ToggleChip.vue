<doc lang="md">
Git Graph ツールバーの小さなトグルボタン。

押されているかどうかを塗りだけでなく、支援技術にも押下状態として伝える。見た目の差だけでは、
これが「押すたびに状態が切り替わるもの」なのか「押すと何かが起きるもの」なのかが伝わらない。
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
