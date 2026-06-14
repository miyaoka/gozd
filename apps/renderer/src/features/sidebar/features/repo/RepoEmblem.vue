<doc lang="md">
repo 名から決定論的に生成する identicon (GitHub アバター方式の左右対称 5x5 グリッド)。
repo 固有の OKLCH 色 + ネオングローで描く。色だけでは判別しづらい repo も、
グリッドの形で識別できる。

色・グリッドパターンはどちらも djb2 hash 由来の動的計算値 (gozd-ui の inline binding 例外 (c))。
同じ repo 名は常に同じ紋章になり、ユーザーは色と形の両方で repo を空間記憶できる。
</doc>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  name: string;
}>();

/** djb2 hash。repo 名 → 安定した 32bit 整数 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

const hash = computed(() => djb2(props.name));
const hue = computed(() => hash.value % 360);

/** identicon ドット (明るい前景) と背景タイル (暗い同 hue 面) */
const dotColor = computed(() => `oklch(0.74 0.17 ${hue.value})`);
const bgColor = computed(() => `oklch(0.27 0.06 ${hue.value})`);

/**
 * 5x5 の左右対称グリッド。左 3 列 (15 セル) を hash の bit で塗り分け、
 * 右 2 列は列 1 / 列 0 をミラーする (GitHub identicon と同方式)。
 * 左右対称にするのは、ランダムなドットより「紋章」として視覚的にまとまるため。
 */
const cells = computed(() => {
  const h = hash.value;
  const result: { x: number; y: number }[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      if (((h >> (col * 5 + row)) & 1) === 0) continue;
      // ミラー先の列: 0→[0,4]、1→[1,3]、2→[2] (中央列はミラーしない)
      const columns = col === 2 ? [2] : [col, 4 - col];
      for (const x of columns) result.push({ x, y: row });
    }
  }
  return result;
});
</script>

<template>
  <span
    class="_fx-emblem grid size-6 shrink-0 place-items-center"
    :style="{ '--emblem-glow': dotColor }"
    aria-hidden="true"
  >
    <svg viewBox="-0.5 -0.5 6 6" class="size-full">
      <rect x="-0.5" y="-0.5" width="6" height="6" rx="1.3" :fill="bgColor" />
      <rect
        v-for="(cell, i) in cells"
        :key="i"
        :x="cell.x"
        :y="cell.y"
        width="1"
        height="1"
        rx="0.28"
        :fill="dotColor"
      />
    </svg>
  </span>
</template>

<style>
._fx-emblem {
  filter: drop-shadow(0 0 4px color-mix(in oklch, var(--emblem-glow) 70%, transparent));
}
</style>
