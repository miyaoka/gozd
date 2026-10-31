<script setup lang="ts">
import { computed } from "vue";
import { useMinuteClock } from "../../shared/time";
import {
  barSegments,
  tickTransform,
  TICK_HOURS,
  timeToPercent,
  type SegmentKind,
} from "./dayProgress";

/** 日付ラベル（月日 + 曜日）。曜日を日付のどちら側に置くか、何で区切るかは locale ごとに
 * 違う（ja は "8/14(金)"、en-US は "Fri, 8/14"）ため、並びは Intl に委ねる。 */
const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "numeric",
  day: "numeric",
});

const now = useMinuteClock();

/** `<time datetime>` に載せる機械可読値。HTML の valid time string（`14:54`）を
 * `Temporal` がそのまま返すので、locale 整形（numbering system が latn とは限らない）を
 * 機械可読値に流さずに済む。 */
const timeAttribute = computed<string>(() =>
  now.value.toPlainTime().toString({ smallestUnit: "minute" }),
);

const todayLabel = computed<string>(() => DATE_LABEL_FORMATTER.format(now.value.toPlainDate()));

const tomorrowLabel = computed<string>(() =>
  DATE_LABEL_FORMATTER.format(now.value.toPlainDate().add({ days: 1 })),
);

const playheadLeft = computed<string>(() => `${timeToPercent(now.value.hour, now.value.minute)}%`);

const SEGMENT_CLASS: Record<SegmentKind, string> = {
  daytime: "bg-clock-daytime",
  nighttime: "bg-clock-nighttime",
};

const segments = barSegments();

const ticks = TICK_HOURS.map((hour) => ({
  hour,
  left: `${timeToPercent(hour)}%`,
  transform: tickTransform(hour),
}));
</script>

<template>
  <time
    class="pointer-events-none flex items-end gap-4"
    :datetime="timeAttribute"
    :aria-label="`Current time ${timeAttribute}, ${todayLabel}`"
  >
    <span class="shrink-0 text-xs leading-none text-foreground tabular-nums">
      {{ todayLabel }}
    </span>

    <div class="flex flex-1 flex-col gap-0.5">
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
        <!-- 帯は重ねず横に並べる。下地を敷いて上に重ねる形だと、境界の隙間から下地が覗く -->
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
    </div>

    <span class="shrink-0 text-xs leading-none text-foreground tabular-nums">
      {{ tomorrowLabel }}
    </span>
  </time>
</template>
