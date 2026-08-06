import { describe, expect, test } from "bun:test";
import { formatRelativeAge, isoToUnixSec } from "./relativeAge";

const nowSec = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;

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
    expect(formatRelativeAge(0).text).toBe("");
    expect(formatRelativeAge(-1).text).toBe("");
    expect(formatRelativeAge(isoToUnixSec("not a date")).text).toBe("");
  });

  test("経過が短いほど強い色を当てる", () => {
    expect(formatRelativeAge(nowSec() - 60).color).toBe("text-success-text");
    expect(formatRelativeAge(nowSec() - 2 * HOUR).color).toBe("text-warning-text");
    expect(formatRelativeAge(nowSec() - 3 * DAY).color).toBe("text-warning-strong-text");
    expect(formatRelativeAge(nowSec() - 40 * DAY).color).toBe("text-foreground-low");
  });

  test("30 日を超えたら相対表記をやめて絶対日付にする", () => {
    const recent = formatRelativeAge(nowSec() - 20 * DAY);
    const old = formatRelativeAge(nowSec() - 40 * DAY);
    expect(recent.text).toContain("ago");
    expect(old.text).not.toContain("ago");
  });

  test("未来時刻は負の経過を文字列へ漏らさない", () => {
    // 時計ずれで updatedAt が未来になっても "-3m ago" のような表記を出さない
    const future = formatRelativeAge(nowSec() + 3 * 60);
    expect(future.text).not.toContain("-");
    expect(future.text).toContain("in");
  });
});
