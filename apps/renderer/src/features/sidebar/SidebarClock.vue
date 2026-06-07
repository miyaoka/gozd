<doc lang="md">
サイドバートップに常駐する現在時刻表示。

クラシック Mac メニューバーの時計を踏襲し、左にアナログ時計、右に HH:MM の
24 時間表記デジタル時計を並べる。秒針 / 秒表示は持たず分単位で更新する。

更新は分境界まで 1 回 setTimeout する adaptive 方式。1 秒ごとの polling を避け、
表示が変わらない時間は wakeup しない。
</doc>

<script setup lang="ts">
import { useTimeoutFn } from "@vueuse/core";
import { computed, ref } from "vue";

const formatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const now = ref(new Date());

const MINUTE_MS = 60 * 1000;

/** 次の分境界（次の :00 秒）までの ms */
function msToNextMinute(d: Date): number {
  return MINUTE_MS - (d.getSeconds() * 1000 + d.getMilliseconds());
}

const delay = ref(msToNextMinute(now.value));
const { start, stop } = useTimeoutFn(
  () => {
    now.value = new Date();
    delay.value = msToNextMinute(now.value);
    stop();
    start();
  },
  delay,
  { immediate: true },
);

const display = computed(() => formatter.format(now.value));

const minuteAngle = computed(() => now.value.getMinutes() * 6);
const hourAngle = computed(() => (now.value.getHours() % 12) * 30 + now.value.getMinutes() * 0.5);
</script>

<template>
  <div class="flex items-center gap-1.5 text-foreground-low">
    <svg viewBox="-10 -10 20 20" class="size-4 shrink-0" role="img" aria-label="Analog clock">
      <circle cx="0" cy="0" r="9" fill="none" stroke="currentColor" stroke-width="2" />
      <line
        x1="0"
        y1="0"
        x2="0"
        y2="-4.5"
        stroke="currentColor"
        stroke-width="1"
        stroke-linecap="round"
        :transform="`rotate(${hourAngle})`"
      />
      <line
        x1="0"
        y1="0"
        x2="0"
        y2="-7"
        stroke="currentColor"
        stroke-width="1"
        stroke-linecap="round"
        :transform="`rotate(${minuteAngle})`"
      />
    </svg>
    <span class="font-sans text-xs tabular-nums" aria-label="Current time">{{ display }}</span>
  </div>
</template>
