<script setup lang="ts">
import { computed } from "vue";
import { formatSessionTime } from "./sessionLogView";

const props = defineProps<{ ts: string; align: "left" | "right" }>();

// テンプレートで戻り値を複数回参照しないよう、分解結果は computed で 1 回だけ求める。
const parts = computed(() => formatSessionTime(props.ts, { seconds: false }));

// 2 行 (別日) のとき、隣接する吹き出し側に寄せる (assistant=左隣→左寄せ、user=右隣→右寄せ)。
const ALIGN_CLASS: Record<"left" | "right", string> = {
  left: "text-left",
  right: "text-right",
};
</script>

<template>
  <span
    class="shrink-0 pb-0.5 text-[10px] leading-tight text-foreground-low tabular-nums"
    :class="ALIGN_CLASS[align]"
  >
    <span v-if="parts.date" class="block">{{ parts.date }}</span>
    {{ parts.time }}
  </span>
</template>
