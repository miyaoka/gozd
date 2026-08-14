<doc lang="md">
タイトルバー中央に置く 1 日の進捗バー。ローカル時刻の 00:00〜24:00 を横一本に写し、
現在位置を playhead で示す。

## 設計判断

- 昼帯は固定時刻（`dayProgress.ts` の帯定義）で、日の出 / 日の入りの実測ではない。
  実測は観測地の緯度経度を要求し、同じタイムゾーン内でも 1 時間以上ずれる。このバーは
  今日がどこまで進んだかの当たりを付ける背景であって、天文情報を出す面ではない
- 日付と時刻の操作は `Temporal` に委ねる。翌日の算出（月末・年末・うるう年の繰り上がり）も
  `datetime` 属性に載せる機械可読値も、標準 API がそのままの形で持っている。テストランナー
  （bun）が `Temporal` を持たないためこの層はテストを持たない
  - TODO: bun が `Temporal` を持つ版になったら、翌日の算出と `datetime` 値にテストを書く
- 更新は分境界に同期する（`useMinuteClock`）。バーの見た目は 1 分では動かない（実幅に対し
  1 分は 1px 未満）が、`datetime` と日付ラベルは分・日をまたいだ瞬間に変わる必要がある
- playhead はバーの上下へはみ出させる。帯の中に収めると昼夜の境界線と見分けが付かない
- タイトルバーはドラッグ領域なので、バー全体を `pointer-events-none` にしてドラッグを
  奪わない。時刻そのものは可視テキストを持たないため `<time>` の datetime と aria-label で渡す
- 両端の日付ラベルは、バーの左端 / 右端がそれぞれ何日の 0 時なのかを示す。バーは 24 時で
  終わらず翌日へ連続するので、右端に翌日を置くと「今どこにいて次に何が来るか」が 1 本で読める
</doc>

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
