<script setup lang="ts">
interface Props {
  /** true でヘッダ全体をドラッグハンドルの cursor にする (in-app パネル)。 */
  grabbable?: boolean;
}

defineProps<Props>();
</script>

<template>
  <header
    class="flex shrink-0 items-start gap-2 border-b border-border bg-panel px-2 py-1"
    :class="grabbable === true ? 'cursor-grab select-none active:cursor-grabbing' : ''"
  >
    <slot name="header" />

    <div class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
      <slot name="trailing" />
    </div>
  </header>
</template>
