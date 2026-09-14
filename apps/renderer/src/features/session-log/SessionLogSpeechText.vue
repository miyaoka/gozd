<doc lang="md">
発言の本文を、行数を切り詰めて見せる抜粋として素のテキストで描画する (terminal preview の
小さな吹き出し用。全文は SessionLogMessageBody が markdown で描く)。`mark` を渡すと本文の先頭に
印を出す。印は本文の文字列に含めない (コピーに混ざらない)。
</doc>

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
