import { describe, expect, test } from "bun:test";
import {
  barSegments,
  hoursOfDay,
  hourToPercent,
  nextDay,
  tickAlign,
  tickTransform,
  TICK_HOURS,
} from "./dayProgress";

describe("hoursOfDay", () => {
  test("深夜 0 時ちょうどは 0", () => {
    expect(hoursOfDay(new Date(2026, 7, 14, 0, 0, 0))).toBe(0);
  });

  test("分と秒を小数時間に含める", () => {
    expect(hoursOfDay(new Date(2026, 7, 14, 8, 30, 0))).toBe(8.5);
  });

  test("日付が変わっても時刻だけを見る", () => {
    expect(hoursOfDay(new Date(2026, 0, 1, 23, 0, 0))).toBe(
      hoursOfDay(new Date(2026, 11, 31, 23, 0, 0)),
    );
  });
});

describe("hourToPercent", () => {
  test("0 時は左端", () => {
    expect(hourToPercent(0)).toBe(0);
  });

  test("正午はバーの中央", () => {
    expect(hourToPercent(12)).toBe(50);
  });

  test("24 時は右端", () => {
    expect(hourToPercent(24)).toBe(100);
  });
});

describe("barSegments", () => {
  test("夜 / 昼 / 夜 の 3 本で 1 日を覆う", () => {
    expect(barSegments().map((s) => s.kind)).toEqual(["nighttime", "daytime", "nighttime"]);
  });

  test("バーの両端は後退させない（隙間を作る相手がいない）", () => {
    const [first, , last] = barSegments();
    expect(first?.left).toBe("calc(0% + 0px)");
    expect(last?.width).toBe("calc(25% - 1px)");
  });

  test("昼帯は 6 時から 12 時間分で、両側の境界を 1px ずつ後退する", () => {
    const [, daytime] = barSegments();
    expect(daytime?.left).toBe("calc(25% + 1px)");
    expect(daytime?.width).toBe("calc(50% - 2px)");
  });

  test("隣り合う帯が同じ境界を 1px ずつ譲り、合計 2px の隙間になる", () => {
    const [first, daytime] = barSegments();
    // 夜帯は右端を 1px 手前で終え、昼帯は左端を 1px 先から始める
    expect(first?.width).toBe("calc(25% - 1px)");
    expect(daytime?.left).toBe("calc(25% + 1px)");
  });

  test("key が帯ごとに一意", () => {
    const keys = barSegments().map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("nextDay", () => {
  test("翌日を返す", () => {
    expect(nextDay(new Date(2026, 7, 14)).getDate()).toBe(15);
  });

  test("月末は翌月 1 日へ繰り上がる", () => {
    const next = nextDay(new Date(2026, 7, 31));
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(1);
  });

  test("年末は翌年 1 月 1 日へ繰り上がる", () => {
    const next = nextDay(new Date(2026, 11, 31));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });

  test("うるう年の 2/28 は 2/29 になる", () => {
    const next = nextDay(new Date(2028, 1, 28));
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(29);
  });

  test("引数の Date を書き換えない", () => {
    const original = new Date(2026, 7, 14);
    nextDay(original);
    expect(original.getDate()).toBe(14);
  });
});

describe("目盛りラベル", () => {
  test("両端はバーの内側へ寄せ、中間は目盛りを中心に置く", () => {
    expect(tickAlign(0)).toBe("start");
    expect(tickAlign(12)).toBe("center");
    expect(tickAlign(24)).toBe("end");
  });

  test("寄せ方に対応する transform を返す", () => {
    expect(tickTransform(0)).toBe("translateX(0)");
    expect(tickTransform(6)).toBe("translateX(-50%)");
    expect(tickTransform(24)).toBe("translateX(-100%)");
  });

  test("全目盛りがバーの範囲に収まる", () => {
    for (const hour of TICK_HOURS) {
      const percent = hourToPercent(hour);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });
});
