import { describe, expect, test } from "bun:test";
import { computeIntraLineRanges, splitSegments } from "./intraLineDiff";

const NO_TIMEOUT_MS = 10_000;

describe("computeIntraLineRanges", () => {
  test("1 行内の単語変更だけが範囲になる", () => {
    const result = computeIntraLineRanges(["const foo = 1;"], ["const bar = 1;"], NO_TIMEOUT_MS);
    expect(result).toBeDefined();
    // "foo" (col 7-10) → "bar" (col 7-10)。前後の一致部分は範囲に含まれない
    expect(result?.old.get(0)).toEqual([{ start: 7, end: 10 }]);
    expect(result?.new.get(0)).toEqual([{ start: 7, end: 10 }]);
  });

  test("VSCode ヒューリスティック: 単語の大部分が変わると単語全体に拡張される", () => {
    // "foobar" → "fazbaz" は一致文字が単語長の 2/3 未満なので単語全体が変更扱い
    const result = computeIntraLineRanges(["foobar = 1;"], ["fazbaz = 1;"], NO_TIMEOUT_MS);
    expect(result?.old.get(0)).toEqual([{ start: 1, end: 7 }]);
    expect(result?.new.get(0)).toEqual([{ start: 1, end: 7 }]);
  });

  test("N 行 vs M 行のブロックでも行ごとの範囲に分解される", () => {
    const result = computeIntraLineRanges(
      ["const a = 1;", "const b = 2;"],
      ["const a = 10;", "const b = 20;", "const c = 30;"],
      NO_TIMEOUT_MS,
    );
    expect(result).toBeDefined();
    // old 側 2 行 / new 側 3 行のどの行にも範囲が閉じている (行を跨ぐ range は分解済み)
    for (const [idx, ranges] of result?.old ?? []) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(2);
      for (const r of ranges) expect(r.end).toBeGreaterThan(r.start);
    }
    for (const [idx, ranges] of result?.new ?? []) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
      for (const r of ranges) expect(r.end).toBeGreaterThan(r.start);
    }
  });

  test("完全一致ブロックは範囲なし", () => {
    const result = computeIntraLineRanges(["same"], ["same"], NO_TIMEOUT_MS);
    expect(result?.old.size).toBe(0);
    expect(result?.new.size).toBe(0);
  });
});

describe("splitSegments", () => {
  test("トークンなし: 変更範囲の境界だけで切れる", () => {
    const segments = splitSegments("const foo = 1;", undefined, [{ start: 7, end: 10 }]);
    expect(segments).toEqual([
      { text: "const ", color: undefined, marked: false },
      { text: "foo", color: undefined, marked: true },
      { text: " = 1;", color: undefined, marked: false },
    ]);
  });

  test("トークン境界と変更範囲境界の両方で切れ、連結すると元テキストに戻る", () => {
    const text = "const foo = 1;";
    const tokens = [
      { content: "const", color: "#f00" },
      { content: " foo = 1;", color: "#0f0" },
    ];
    // "st fo" (col 4-9) がトークン境界 (offset 5) を跨ぐ
    const segments = splitSegments(text, tokens, [{ start: 4, end: 9 }]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments).toEqual([
      { text: "con", color: "#f00", marked: false },
      { text: "st", color: "#f00", marked: true },
      { text: " fo", color: "#0f0", marked: true },
      { text: "o = 1;", color: "#0f0", marked: false },
    ]);
  });

  test("複数範囲は昇順に消費される", () => {
    const segments = splitSegments("abcdef", undefined, [
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
    expect(segments).toEqual([
      { text: "ab", color: undefined, marked: true },
      { text: "cd", color: undefined, marked: false },
      { text: "ef", color: undefined, marked: true },
    ]);
  });

  test("範囲なしはトークンのままの segment 列になる", () => {
    const tokens = [
      { content: "a", color: "#f00" },
      { content: "b", color: "#0f0" },
    ];
    const segments = splitSegments("ab", tokens, undefined);
    expect(segments).toEqual([
      { text: "a", color: "#f00", marked: false },
      { text: "b", color: "#0f0", marked: false },
    ]);
  });

  test("空行は segment なし", () => {
    expect(splitSegments("", undefined, undefined)).toEqual([]);
  });
});
