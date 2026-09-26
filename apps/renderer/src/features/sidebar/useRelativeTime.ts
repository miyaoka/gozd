import { useTimeoutFn } from "@vueuse/core";
import { ref, watch, type Ref } from "vue";
import { ageColor, formatShortAge } from "../../shared/time";

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

export interface RelativeTimeDisplay {
  text: string;
  color: string;
}

/**
 * baseTime（最後の活動時刻）からの相対時刻と鮮度色を表示するための composable。
 * 色はダッシュボード等の一覧と同じ age-* スケール（`ageColor`）で塗る。色帯の境界
 * （1 日 / 1 週 / 4 週）はいずれも日単位の表示境界と一致するため、同じ wakeup で色も追従する。
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
 * baseTime が undefined のあいだは text を空文字で返し、タイマーは VueUse が scope dispose で
 * 自動 stop する（`tryOnScopeDispose(stop)` が `useTimeoutFn` 内部に含まれている）。
 */
export function useRelativeTime(baseTime: Ref<number | undefined>): Ref<RelativeTimeDisplay> {
  const display = ref<RelativeTimeDisplay>({ text: "", color: "" });
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
      display.value = { text: "", color: "" };
      stop();
      return;
    }
    const now = Date.now();
    display.value = {
      text: formatShortAge(latest, now),
      color: ageColor(Math.floor(latest / 1000), Math.floor(now / 1000)),
    };
    nextDelay.value = nextBoundaryDelay(now - latest);
    stop();
    start();
  }

  watch(baseTime, apply, { immediate: true });

  return display;
}
