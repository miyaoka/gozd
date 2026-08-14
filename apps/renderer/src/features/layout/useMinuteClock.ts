import { useTimeoutFn } from "@vueuse/core";
import { ref, type Ref } from "vue";

/**
 * 分が変わるたびに更新される現在時刻。
 *
 * 次の分境界までの残り時間を毎回計算して `setTimeout` を張り直す。固定間隔の
 * `setInterval`（`useNow({ interval })` が内部で使う）だと位相が mount 時刻に固定され、
 * 分の変わり目から最大 59 秒ずれたまま更新し続ける。同じ壁時計を見せる面が画面に
 * 複数あると、その 2 つが互いに食い違って見える。
 *
 * `Temporal` は Chromium にはあるがテストランナー（bun 1.3.14）には無いため、
 * この composable の検証は実画面でのみ行う。
 */
const MINUTE_MS = 60 * 1000;

/** 次の分境界（次の :00 秒）までの ms */
function msToNextMinute(now: Temporal.PlainDateTime): number {
  return MINUTE_MS - (now.second * 1000 + now.millisecond);
}

export function useMinuteClock(): Ref<Temporal.PlainDateTime> {
  const now = ref(Temporal.Now.plainDateTimeISO());
  const delay = ref(msToNextMinute(now.value));

  const { start, stop } = useTimeoutFn(
    () => {
      now.value = Temporal.Now.plainDateTimeISO();
      delay.value = msToNextMinute(now.value);
      stop();
      start();
    },
    delay,
    { immediate: true },
  );

  return now;
}
