<doc lang="md">
diff 1 行分の本文描画。Shiki トークン (文字色) と行内変更範囲 (背景強調) の 2 レイヤーを
1 本の span 列に合成する。

トークン境界と変更範囲境界は独立に走るため、両方の境界で segment を切り (splitSegments)、
segment ごとに「文字色 = トークン由来、背景 = 変更範囲内なら markClass」を当てる。
背景は inline span の background なので contenteditable コピーの clipboard 内容には影響しない。

トークン未取得 (言語不明 / ロード前) でも行内変更範囲の強調だけは描画される。
</doc>

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
