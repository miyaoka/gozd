import { describe, expect, test } from "bun:test";
import { segmentLine } from "./segmentLine";

describe("segmentLine", () => {
  test("範囲なしは全体を非マッチ 1 区間で返す", () => {
    expect(segmentLine("hello", [])).toEqual([{ text: "hello", isMatch: false }]);
  });

  test("行中の 1 マッチを前後で分割する", () => {
    // "const foo = 1;" の foo (col 6-9)
    expect(segmentLine("const foo = 1;", [{ startColumn: 6, endColumn: 9 }])).toEqual([
      { text: "const ", isMatch: false },
      { text: "foo", isMatch: true },
      { text: " = 1;", isMatch: false },
    ]);
  });

  test("行頭マッチは前の非マッチ区間を作らない", () => {
    expect(segmentLine("foobar", [{ startColumn: 0, endColumn: 3 }])).toEqual([
      { text: "foo", isMatch: true },
      { text: "bar", isMatch: false },
    ]);
  });

  test("複数マッチを順に分割する", () => {
    // "a x a" の a を 2 箇所
    expect(
      segmentLine("a x a", [
        { startColumn: 0, endColumn: 1 },
        { startColumn: 4, endColumn: 5 },
      ]),
    ).toEqual([
      { text: "a", isMatch: true },
      { text: " x ", isMatch: false },
      { text: "a", isMatch: true },
    ]);
  });

  test("行末までのマッチは末尾非マッチ区間を作らない", () => {
    expect(segmentLine("ab", [{ startColumn: 1, endColumn: 2 }])).toEqual([
      { text: "a", isMatch: false },
      { text: "b", isMatch: true },
    ]);
  });
});
