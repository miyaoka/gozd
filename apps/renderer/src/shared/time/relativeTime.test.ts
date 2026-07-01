import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  formatCompactTime,
  formatDetailTime,
  formatRelativeTime,
  formatShortAge,
} from "./relativeTime";

// 2026-05-21T00:00:00Z 固定 (テスト独立性のため Date.now を spyOn で固定)
const FIXED_NOW_MS = 1779580800000;
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

describe("formatRelativeTime", () => {
  let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">> | undefined;

  function freezeNow() {
    nowSpy = spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS);
  }

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  test("unixSec <= 0 は空文字", () => {
    freezeNow();
    expect(formatRelativeTime(0)).toBe("");
    expect(formatRelativeTime(-1)).toBe("");
  });

  test("過去: 秒 / 分 / 時 / 日 / 月 / 年の境界", () => {
    freezeNow();
    // Intl.RelativeTimeFormat({ style: "narrow", numeric: "always", locale: "en" }) の
    // 出力を pin。narrow style は単位の短縮表記 (s/m/h/d/mo/y) と "ago" suffix を返す。
    expect(formatRelativeTime(FIXED_NOW_SEC - 30)).toBe("30s ago");
    expect(formatRelativeTime(FIXED_NOW_SEC - 5 * 60)).toBe("5m ago");
    expect(formatRelativeTime(FIXED_NOW_SEC - 2 * 3600)).toBe("2h ago");
    expect(formatRelativeTime(FIXED_NOW_SEC - 3 * 86400)).toBe("3d ago");
    expect(formatRelativeTime(FIXED_NOW_SEC - 60 * 86400)).toBe("2mo ago");
    expect(formatRelativeTime(FIXED_NOW_SEC - 3 * 365 * 86400)).toBe("3y ago");
  });

  test("未来 (時計ズレ) は `in Ns` 表記。負号で表示しない", () => {
    freezeNow();
    // CodeRabbit 指摘範囲: 自前実装だと "-5s ago" が出る経路を Intl 経由で構造的に解消
    expect(formatRelativeTime(FIXED_NOW_SEC + 5)).toBe("in 5s");
    expect(formatRelativeTime(FIXED_NOW_SEC + 120)).toBe("in 2m");
  });

  test("ちょうど今 (diff=0) は 0s ago (numeric:always)", () => {
    freezeNow();
    expect(formatRelativeTime(FIXED_NOW_SEC)).toBe("0s ago");
  });
});

// formatCompactTime / formatDetailTime は locale 未指定 (システムロケール依存) のため、
// 出力文字列をロケール固定で pin しない。年・時刻の有無という構造的性質だけを検証する。
describe("formatCompactTime", () => {
  let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">> | undefined;

  function freezeNow() {
    nowSpy = spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS);
  }

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  test("unixSec <= 0 は空文字", () => {
    freezeNow();
    expect(formatCompactTime(0)).toBe("");
    expect(formatCompactTime(-1)).toBe("");
  });

  test("今年の日付は時刻を含み年を含まない", () => {
    freezeNow();
    const result = formatCompactTime(FIXED_NOW_SEC - 10 * 86400);
    expect(result).toContain(":");
    expect(result).not.toContain("2026");
  });

  test("今年以外の日付は年を含み時刻を含まない", () => {
    freezeNow();
    const result = formatCompactTime(FIXED_NOW_SEC - 365 * 86400);
    expect(result).toContain("2025");
    expect(result).not.toContain(":");
  });
});

describe("formatDetailTime", () => {
  test("unixSec <= 0 は空文字", () => {
    expect(formatDetailTime(0)).toBe("");
    expect(formatDetailTime(-1)).toBe("");
  });

  test("年・時・分・秒をすべて含む", () => {
    const result = formatDetailTime(FIXED_NOW_SEC);
    expect(result).toContain("2026");
    // hour:minute:second の区切り 2 箇所
    expect(result.match(/:/g)?.length).toBe(2);
  });
});

describe("formatShortAge", () => {
  test("60s 未満は `now`", () => {
    expect(formatShortAge(1000, 1000)).toBe("now");
    expect(formatShortAge(1000, 1000 + 59_000)).toBe("now");
  });

  test("60s 〜 60m 未満は Nm", () => {
    expect(formatShortAge(0, 60_000)).toBe("1m");
    expect(formatShortAge(0, 59 * 60_000)).toBe("59m");
  });

  test("60m 〜 24h 未満は Nh", () => {
    expect(formatShortAge(0, 60 * 60_000)).toBe("1h");
    expect(formatShortAge(0, 23 * 60 * 60_000)).toBe("23h");
  });

  test("24h 以上は Nd", () => {
    expect(formatShortAge(0, 24 * 60 * 60_000)).toBe("1d");
    expect(formatShortAge(0, 7 * 24 * 60 * 60_000)).toBe("7d");
  });
});
