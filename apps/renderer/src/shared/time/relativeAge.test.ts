import { describe, expect, test } from "bun:test";
import { ageColor, formatRelativeAge, isoToUnixSec } from "./relativeAge";

// 時計を固定して帯の境界そのものを踏む（相対入力だと ms の丸めで帯をまたぎフレークになる）
const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;

const at = (ageSec: number) => formatRelativeAge(NOW - ageSec, NOW);

describe("isoToUnixSec", () => {
  test("ISO 8601 を Unix 秒に変換する", () => {
    expect(isoToUnixSec("2026-08-05T11:07:03Z")).toBe(Date.parse("2026-08-05T11:07:03Z") / 1000);
  });

  test("parse できない入力は 0 に倒す", () => {
    expect(isoToUnixSec("")).toBe(0);
    expect(isoToUnixSec("not a date")).toBe(0);
  });
});

describe("formatRelativeAge", () => {
  test("日付が分からない項目はテキストを出さない", () => {
    // 呼び出し側に fallback を書かせないため、空文字を関数仕様として固定する
    expect(formatRelativeAge(0, NOW).text).toBe("");
    expect(formatRelativeAge(0, NOW).color).toBe("text-foreground-muted");
    expect(formatRelativeAge(-1, NOW).text).toBe("");
    expect(formatRelativeAge(isoToUnixSec("not a date"), NOW).text).toBe("");
  });

  test("鮮度色の境界は未満", () => {
    expect(at(DAY - 1).color).toBe("text-age-hour");
    expect(at(DAY).color).toBe("text-age-day");
    expect(at(7 * DAY - 1).color).toBe("text-age-day");
    expect(at(7 * DAY).color).toBe("text-age-week");
    expect(at(28 * DAY - 1).color).toBe("text-age-week");
    expect(at(28 * DAY).color).toBe("text-age-date");
  });

  test("4 週間ちょうどで相対表記から絶対日付へ切り替わる", () => {
    expect(at(28 * DAY - 1).text).toContain("ago");
    expect(at(28 * DAY).text).not.toContain("ago");
  });

  test("テキストと色は同じ時計から導く", () => {
    // 注入した時計を text 側が無視して実時刻を読むと、経過が NOW からの距離ぶんずれてこの
    // 文字列と一致しなくなる。厳密比較にしているのは、`ago` の有無だけを見る形だと
    // 実行日が NOW を追い越した時点で退行を検出できなくなるため
    expect(at(2 * HOUR).text).toBe("2h ago");
    expect(at(2 * HOUR).color).toBe("text-age-hour");
  });

  test("未来時刻は負の経過を文字列へ漏らさない", () => {
    // 時計ずれで updatedAt が未来になっても "-3m ago" のような表記を出さない
    const future = formatRelativeAge(NOW + 3 * 60, NOW);
    expect(future.text).not.toContain("-");
    expect(future.text).toContain("in");
    expect(future.color).toBe("text-age-hour");
  });
});

describe("ageColor", () => {
  const color = (ageSec: number) => ageColor(NOW - ageSec, NOW);

  test("鮮度色の境界は未満", () => {
    expect(color(DAY - 1)).toBe("text-age-hour");
    expect(color(DAY)).toBe("text-age-day");
    expect(color(7 * DAY - 1)).toBe("text-age-day");
    expect(color(7 * DAY)).toBe("text-age-week");
    expect(color(28 * DAY - 1)).toBe("text-age-week");
    expect(color(28 * DAY)).toBe("text-age-date");
  });

  test("日付が分からない項目は最も弱い色に倒す", () => {
    // 絶対時刻を出す一覧はこの分岐を踏む（Working Tree 行は clean / 未取得のとき mtime が 0）。
    // formatRelativeAge は同じ入力を自前で早期 return するため、そちら経由では到達しない
    expect(ageColor(0, NOW)).toBe("text-foreground-muted");
    expect(ageColor(-1, NOW)).toBe("text-foreground-muted");
  });
});
