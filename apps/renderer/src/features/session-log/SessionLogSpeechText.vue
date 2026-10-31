<script setup lang="ts">
defineProps<{
  text: string;
  mark?: string;
}>();
</script>

<template>
  <span class="_speech-text" :data-mark="mark">{{ text }}</span>
</template>

<style scoped>
._speech-text[data-mark]::before {
  content: attr(data-mark) " ";
}
</style>
