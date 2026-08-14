<doc lang="md">
サイドバートップに常駐する現在時刻表示。

クラシック Mac メニューバーの時計を踏襲し、左にアナログ時計、右に HH:MM の
24 時間表記デジタル時計を並べる。秒針 / 秒表示は持たず分単位で更新する。

更新は `useMinuteClock`（分境界に同期する共有 composable）に委ねる。1 秒ごとの polling を
避け、表示が変わらない時間は wakeup しない。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useMinuteClock } from "../../shared/time";

const now = useMinuteClock();

/** デジタル表示。locale の 12 時間制設定に関わらず 24 時間表記へ固定するため、
 * `Temporal` が返す ISO 8601 の `HH:MM` をそのまま出す。
 *
 * `Intl.DateTimeFormat` に委ねて区切り文字を locale に従わせると、桁が揺れる。
 * `Intl.DateTimeFormat` は `Date` 用と Temporal 型用で別の format record を持ち
 * (`[[DateTimeFormat]]` と `[[TemporalPlainTimeFormat]]`)、後者は生成時に locale の
 * available pattern から選び直される。ja-JP の time pattern は numeric hour (`H:mm`) な
 * ため `hour: "2-digit"` の要求はそこで落ち、`09:36` が `9:36`、`00:05` が `0:05` になる
 * (`resolvedOptions().hour` は `[[DateTimeFormat]]` 側を映すので `2-digit` のまま)。
 * オプションで変えられる段階の話ではない。tabular-nums で揃えた時計の幅が分ごとに
 * 変わるより、区切り文字が ISO に固定される方を採る。 */
const display = computed(() => now.value.toPlainTime().toString({ smallestUnit: "minute" }));

const minuteAngle = computed(() => now.value.minute * 6);
const hourAngle = computed(() => (now.value.hour % 12) * 30 + now.value.minute * 0.5);
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
    <span class="_fx-hud-readout font-mono text-xs tabular-nums" aria-label="Current time">{{
      display
    }}</span>
  </div>
</template>
