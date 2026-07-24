import { describe, expect, test } from "bun:test";
import { isPrListFetchDue } from "./usePrListStore";

const NOW = 1_000_000;

describe("isPrListFetchDue", () => {
  test("lock 未設定 (allowedAt undefined) は対象", () => {
    expect(isPrListFetchDue({ allowedAt: undefined, now: NOW })).toBe(true);
  });

  test("lock 期間中 (allowedAt が未来) は対象外", () => {
    expect(isPrListFetchDue({ allowedAt: NOW + 1, now: NOW })).toBe(false);
  });

  // 境界: lock 期限ちょうど (now === allowedAt) は抜けたとみなす
  test("lock 期限ちょうどは対象", () => {
    expect(isPrListFetchDue({ allowedAt: NOW, now: NOW })).toBe(true);
  });

  test("lock 期限が過ぎていれば対象", () => {
    expect(isPrListFetchDue({ allowedAt: NOW - 1, now: NOW })).toBe(true);
  });
});
