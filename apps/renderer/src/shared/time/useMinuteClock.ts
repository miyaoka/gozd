import { useTimeoutFn } from "@vueuse/core";
import { shallowRef, type ShallowRef } from "vue";

/** 1 分（ms）。 */
const MINUTE_MS = 60 * 1000;

/** 次の分境界（次の :00 秒）までの ms */
function msToNextMinute(now: Temporal.PlainDateTime): number {
  return MINUTE_MS - (now.second * 1000 + now.millisecond);
}

/**
 * 分が変わるたびに更新される現在時刻。
 *
 * 次の分境界までの残り時間を毎回計算して `setTimeout` を張り直す。固定間隔の
 * `setInterval` だと位相が呼び出し時刻に固定され、分の変わり目から最大 59 秒ずれたまま
 * 更新し続ける。同じ壁時計を見せる面が画面に複数あると、その 2 つが互いに食い違って見える。
 *
 * 値を `shallowRef` で持つのは、`Temporal` の各型が内部スロットを持つ exotic object で
 * reactive proxy に包むと壊れるため。Vue は proxy 化の対象を Object / Array / Map / Set 系に
 * 限っており実際には包まれないが、それは実装詳細への暗黙の依存になる。
 *
 * `Temporal` は Chromium にはあるがテストランナー（bun）には無いため、この composable の
 * 検証は実画面でのみ行う。
 *
 * TODO: bun が `Temporal` を持つ版になったらテストを書く。
 */
export function useMinuteClock(): ShallowRef<Temporal.PlainDateTime> {
  const now = shallowRef(Temporal.Now.plainDateTimeISO());
  const delay = shallowRef(msToNextMinute(now.value));

  // start() は先頭で clear() するため、張り直しに stop() は要らない。
  const { start } = useTimeoutFn(
    () => {
      now.value = Temporal.Now.plainDateTimeISO();
      delay.value = msToNextMinute(now.value);
      start();
    },
    delay,
    { immediate: true },
  );

  return now;
}
