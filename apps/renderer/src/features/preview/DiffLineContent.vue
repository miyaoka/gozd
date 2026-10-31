<script setup lang="ts">
import { computed } from "vue";
import { type ColRange, splitSegments } from "./intraLineDiff";
import type { ThemedToken } from "./useHighlight";

const props = defineProps<{
  text: string;
  tokens?: ThemedToken[];
  /** 行内変更範囲 (1-based / end-exclusive column)。undefined なら強調なし */
  ranges?: ColRange[];
  /** 強調 segment に当てる背景クラス。added / removed で呼び出し側が切り替える */
  markClass: string;
}>();

const segments = computed(() => splitSegments(props.text, props.tokens, props.ranges));
</script>

<template>
  <span
    v-for="(seg, i) in segments"
    :key="i"
    :class="seg.marked ? markClass : undefined"
    :style="seg.color ? { color: seg.color } : undefined"
    >{{ seg.text }}</span
  >
</template>
