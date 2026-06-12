<doc lang="md">
repo 名から決定論的に色を導出するダイヤ型の紋章 (crest)。サイドバーの repo ヘッダで
folder アイコンの代わりに使い、repo ごとの視覚的アイデンティティを与える。

色は名前の djb2 hash から hue を引く動的計算色 (gozd-ui の inline binding 例外 (c))。
同じ repo 名は常に同じ配色になるため、ユーザーは色で repo を空間記憶できる。
</doc>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  name: string;
}>();

/** djb2 hash。repo 名 → 安定した整数 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

const hue = computed(() => djb2(props.name) % 360);
/** 主色とハイライトの 2 色グラデーション。hue を 45° ずらして宝石らしい照りを出す */
const colorA = computed(() => `oklch(0.65 0.16 ${hue.value})`);
const colorB = computed(() => `oklch(0.8 0.14 ${(hue.value + 45) % 360})`);

const initial = computed(() => props.name.charAt(0).toUpperCase());
</script>

<template>
  <span
    class="relative grid size-6 shrink-0 place-items-center"
    :style="{ '--emblem-a': colorA, '--emblem-b': colorB }"
    aria-hidden="true"
  >
    <span class="_fx-emblem-gem absolute inset-1"></span>
    <span class="relative text-[10px] font-black text-foreground">{{ initial }}</span>
  </span>
</template>

<style>
._fx-emblem-gem {
  transform: rotate(45deg);
  border-radius: 3px;
  background: linear-gradient(135deg, var(--emblem-a), var(--emblem-b));
  box-shadow:
    0 0 8px color-mix(in oklch, var(--emblem-a) 60%, transparent),
    inset 0 1px 1px oklch(1 0 0 / 0.4),
    inset 0 -1px 2px oklch(0 0 0 / 0.4);
}
</style>
