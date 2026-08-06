import { describe, expect, test } from "bun:test";
import { isMyWorkFetchDue } from "./useMyWorkStore";

const NOW = 1_000_000;

describe("isMyWorkFetchDue", () => {
  test("一度も取得していなければ取得する", () => {
    expect(isMyWorkFetchDue({ allowedAt: undefined, now: NOW })).toBe(true);
  });

  test("lock が未来なら抑制する", () => {
    expect(isMyWorkFetchDue({ allowedAt: NOW + 1, now: NOW })).toBe(false);
  });

  test("lock 到達ちょうどで取得する", () => {
    expect(isMyWorkFetchDue({ allowedAt: NOW, now: NOW })).toBe(true);
  });

  test("lock を過ぎていれば取得する", () => {
    expect(isMyWorkFetchDue({ allowedAt: NOW - 1, now: NOW })).toBe(true);
  });
});
