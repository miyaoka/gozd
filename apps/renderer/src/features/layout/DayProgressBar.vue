<doc lang="md">
タイトルバー中央に置く 1 日の進捗バー。ローカル時刻の 00:00〜24:00 を横一本に写し、
現在位置を playhead で示す。

## 設計判断

- 昼帯は固定時刻（`dayProgress.ts` の `DAYTIME_*`）で、日の出 / 日の入りの実測ではない。
  実測は観測地の緯度経度を要求し、同じタイムゾーン内でも 1 時間以上ずれる。このバーは
  今日がどこまで進んだかの当たりを付ける背景であって、天文情報を出す面ではない
- 更新間隔は 1 分。バーの実幅に対して 1 分は 1px に満たないため、それより細かく刻んでも
  見た目は変わらず再描画だけが増える
- playhead はバーの上下へはみ出させる。帯の中に収めると昼夜の境界線と見分けが付かない
- タイトルバーはドラッグ領域なので、バー全体を `pointer-events-none` にしてドラッグを
  奪わない。可視テキストを持たない図なので、時刻は `<time>` の datetime と aria-label で渡す
</doc>

<script setup lang="ts">
import { useNow } from "@vueuse/core";
import { computed } from "vue";
import {
  barSegments,
  formatClockTime,
  hoursOfDay,
  hourToPercent,
  tickTransform,
  TICK_HOURS,
  type SegmentKind,
} from "./dayProgress";

const MINUTE_MS = 60_000;

const now = useNow({ interval: MINUTE_MS });

const clockTime = computed<string>(() => formatClockTime(now.value));

const playheadLeft = computed<string>(() => `${hourToPercent(hoursOfDay(now.value))}%`);

const SEGMENT_CLASS: Record<SegmentKind, string> = {
  daytime: "bg-daytime",
  nighttime: "bg-nighttime",
};

const segments = barSegments();

interface Tick {
  hour: number;
  left: string;
  transform: string;
}

const ticks = computed<Tick[]>(() =>
  TICK_HOURS.map((hour) => ({
    hour,
    left: `${hourToPercent(hour)}%`,
    transform: tickTransform(hour),
  })),
);
</script>

<template>
  <time
    class="pointer-events-none flex flex-col gap-0.5"
    :datetime="clockTime"
    :aria-label="`Current time ${clockTime}`"
  >
    <div class="relative h-2.5">
      <span
        v-for="tick in ticks"
        :key="tick.hour"
        class="absolute top-0 text-[9px] leading-none text-foreground-low tabular-nums"
        :style="{ left: tick.left, transform: tick.transform }"
      >
        {{ tick.hour }}
      </span>
    </div>

    <div class="relative">
      <!-- 帯は重ねず横に並べる。地を敷いて上に重ねる形だと境界の隙間から地の色が覗く -->
      <div class="relative h-1.5 overflow-hidden rounded-full">
        <div
          v-for="segment in segments"
          :key="segment.key"
          class="absolute inset-y-0 rounded-full"
          :class="SEGMENT_CLASS[segment.kind]"
          :style="{ left: segment.left, width: segment.width }"
        ></div>
      </div>
      <!-- playhead: バーの上下へはみ出させて昼夜の境界と区別する。縁取りは border ではなく
           outline で外側に出す（border は内側を削るため、細い棒だと白の芯が消える） -->
      <div
        class="absolute -inset-y-0.5 w-1 -translate-x-1/2 rounded-full bg-foreground outline-2 outline-background"
        :style="{ left: playheadLeft }"
      ></div>
    </div>
  </time>
</template>
