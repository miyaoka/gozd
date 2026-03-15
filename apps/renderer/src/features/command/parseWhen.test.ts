import { describe, expect, test } from "bun:test";
import { parseWhen } from "./parseWhen";
import type { When } from "./types";

describe("parseWhen", () => {
  test("undefined は undefined を返す", () => {
    expect(parseWhen(undefined)).toBeUndefined();
  });

  test("空文字列は undefined を返す", () => {
    expect(parseWhen("")).toBeUndefined();
    expect(parseWhen("  ")).toBeUndefined();
  });

  test("単一 context key", () => {
    expect(parseWhen("terminalFocus")).toEqual({
      type: "key",
      key: "terminalFocus",
    });
  });

  test("NOT", () => {
    expect(parseWhen("!terminalFocus")).toEqual({
      type: "not",
      value: { type: "key", key: "terminalFocus" },
    });
  });

  test("二重 NOT", () => {
    expect(parseWhen("!!terminalFocus")).toEqual({
      type: "not",
      value: { type: "not", value: { type: "key", key: "terminalFocus" } },
    });
  });

  test("AND", () => {
    expect(parseWhen("terminalFocus && previewVisible")).toEqual({
      type: "and",
      values: [
        { type: "key", key: "terminalFocus" },
        { type: "key", key: "previewVisible" },
      ],
    });
  });

  test("OR", () => {
    expect(parseWhen("terminalFocus || previewVisible")).toEqual({
      type: "or",
      values: [
        { type: "key", key: "terminalFocus" },
        { type: "key", key: "previewVisible" },
      ],
    });
  });

  test("AND は OR より結合が強い", () => {
    // "a && b || c" → or(and(a, b), c)
    const result = parseWhen("terminalFocus && previewVisible || terminalFocus") as When;
    expect(result.type).toBe("or");
    if (result.type !== "or") throw new Error("expected or");
    expect(result.values).toHaveLength(2);
    expect(result.values[0]).toEqual({
      type: "and",
      values: [
        { type: "key", key: "terminalFocus" },
        { type: "key", key: "previewVisible" },
      ],
    });
    expect(result.values[1]).toEqual({ type: "key", key: "terminalFocus" });
  });

  test("NOT と AND の組み合わせ", () => {
    expect(parseWhen("terminalFocus && !previewVisible")).toEqual({
      type: "and",
      values: [
        { type: "key", key: "terminalFocus" },
        { type: "not", value: { type: "key", key: "previewVisible" } },
      ],
    });
  });

  test("未知の context key はエラー", () => {
    expect(() => parseWhen("unknownKey")).toThrow("Unknown context key");
  });

  test("不正な文字はエラー", () => {
    expect(() => parseWhen("terminalFocus @")).toThrow("Unexpected character");
  });

  test("途中で途切れるとエラー", () => {
    expect(() => parseWhen("terminalFocus &&")).toThrow("Unexpected end");
  });

  test("余分なトークンがあるとエラー", () => {
    expect(() => parseWhen("terminalFocus previewVisible")).toThrow("Unexpected token");
  });
});
