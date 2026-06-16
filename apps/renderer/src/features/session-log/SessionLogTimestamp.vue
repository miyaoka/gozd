<doc lang="md">
チャット吹き出し脇の時刻ラベル。`ts` を `formatSessionTime` で日付 / 時刻へ分解し、
日付があれば時刻の上に改行して 2 行で出す (resume で日をまたいだ際、日付と時刻が 1 行で
詰まって読みにくくなるのを避ける)。今日のエントリは日付が空文字なので時刻 1 行になる。
秒は出さない (会話の時刻表示は分までで足りる。秒精度が要る一意識別は目次が担う)。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { formatSessionTime } from "./sessionLogView";

const props = defineProps<{ ts: string; align: "left" | "right" }>();

// テンプレートで戻り値を複数回参照しないよう、分解結果は computed で 1 回だけ求める。
// 会話の時刻表示は分までで足りるため秒は出さない (秒精度の一意識別は目次が担う)。
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
