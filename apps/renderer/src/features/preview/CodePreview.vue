<script setup lang="ts">
import { watch, ref } from "vue";
import { highlight } from "./useHighlight";

const props = defineProps<{
  content: string;
  filePath: string;
}>();

const highlightedHtml = ref<string>();

/** 非同期レース防止用のバージョンカウンター */
let highlightVersion = 0;

watch(
  () => [props.content, props.filePath],
  () => {
    highlightedHtml.value = undefined;
    const version = ++highlightVersion;
    highlight(props.content, props.filePath).then((html) => {
      if (version === highlightVersion && html) highlightedHtml.value = html;
    });
  },
  { immediate: true },
);
</script>

<template>
  <!-- ハイライト済み HTML -->
  <div v-if="highlightedHtml" class="_highlighted-code text-sm/tight" v-html="highlightedHtml" />

  <!-- フォールバック: プレーンテキスト -->
  <pre v-else class="_line-numbered p-4 text-sm/tight text-zinc-300"><code><span
        v-for="(line, i) in content.split('\n')"
        :key="i"
        class="_line"
        :data-line="i + 1"
      >{{ line }}
</span></code></pre>
</template>

<style scoped>
._line-numbered ._line::before,
._highlighted-code :deep(.line::before) {
  content: attr(data-line);
  display: inline-block;
  width: 3ch;
  margin-right: 1.5ch;
  text-align: right;
  color: var(--color-zinc-600);
  user-select: none;
}

._highlighted-code :deep(pre) {
  padding: 1rem;
  margin: 0;
  background: transparent !important;
}

._highlighted-code :deep(code) {
  font-family: inherit;
}
</style>
