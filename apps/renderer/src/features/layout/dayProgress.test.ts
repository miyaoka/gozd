import { describe, expect, test } from "bun:test";
import { barSegments, tickTransform, TICK_HOURS, timeToPercent } from "./dayProgress";

describe("timeToPercent", () => {
  test("0 時は左端", () => {
    expect(timeToPercent(0)).toBe(0);
  });

  test("正午はバーの中央", () => {
    expect(timeToPercent(12)).toBe(50);
  });

  test("24 時は右端", () => {
    expect(timeToPercent(24)).toBe(100);
  });

  test("分を小数時間として位置に含める", () => {
    expect(timeToPercent(8, 30)).toBe(timeToPercent(8.5));
  });

  test("分を省略すると 0 分として扱う", () => {
    expect(timeToPercent(8)).toBe(timeToPercent(8, 0));
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

describe("目盛りラベル", () => {
  test("両端はバーの内側へ寄せ、中間は目盛りを中心に置く", () => {
    expect(tickTransform(0)).toBe("translateX(0)");
    expect(tickTransform(12)).toBe("translateX(-50%)");
    expect(tickTransform(24)).toBe("translateX(-100%)");
  });

  test("全目盛りがバーの範囲に収まる", () => {
    for (const hour of TICK_HOURS) {
      const percent = timeToPercent(hour);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });
});
