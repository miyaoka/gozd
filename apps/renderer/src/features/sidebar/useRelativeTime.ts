import { useTimeoutFn } from "@vueuse/core";
import { ref, watch, type Ref } from "vue";
import { formatRelativeTime } from "./utils";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 表示が次に変化するまでの ms を返す。
 * 表示は `<60s → now`, `<60m → Nm`, `<24h → Nh`, `>=24h → Nd` の階段関数。
 * 階段の次の段までの差分で setTimeout すれば、表示が変わらない時間は wakeup しない。
 */
function nextBoundaryDelay(elapsed: number): number {
  if (elapsed < MINUTE_MS) return MINUTE_MS - elapsed;
  if (elapsed < HOUR_MS) return MINUTE_MS - (elapsed % MINUTE_MS);
  if (elapsed < DAY_MS) return HOUR_MS - (elapsed % HOUR_MS);
  return DAY_MS - (elapsed % DAY_MS);
}

/**
 * baseTime（最後の活動時刻）からの相対時刻を表示するための composable。
 *
 * 1秒間隔の polling はせず、表示が次に変わる境界まで setTimeout で 1 回だけ wakeup する
 * adaptive 方式（github/relative-time-element と同じ）。計算は常に `Date.now() - baseTime`
 * を直接読むため、baseTime と現在時刻が別クロックでずれて elapsed が負になることはない。
 *
 * 経路の分離:
 * - `watch(baseTime, apply, ...)` — 上流の baseTime 変化を引数で受けて `apply(latest)`
 * - `useTimeoutFn` の cb — 自己反復。`baseTime.value` を読み直して `apply` に渡す
 * - `apply(latest)` — 唯一の更新点。display を書き換え、次の境界で再 schedule
 *
 * baseTime が undefined のあいだは空文字を返し、タイマーは VueUse が scope dispose で
 * 自動 stop する（`tryOnScopeDispose(stop)` が `useTimeoutFn` 内部に含まれている）。
 */
export function useRelativeTime(baseTime: Ref<number | undefined>): Ref<string> {
  const display = ref("");
  const nextDelay = ref(MINUTE_MS);

  const { start, stop } = useTimeoutFn(
    () => {
      apply(baseTime.value);
    },
    nextDelay,
    { immediate: false },
  );

  function apply(latest: number | undefined) {
    if (latest === undefined) {
      display.value = "";
      stop();
      return;
    }
    const now = Date.now();
    display.value = formatRelativeTime(latest, now);
    nextDelay.value = nextBoundaryDelay(now - latest);
    stop();
    start();
  }

  watch(baseTime, apply, { immediate: true });

  return display;
}
