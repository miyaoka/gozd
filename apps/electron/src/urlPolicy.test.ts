// 外部送り境界の回帰テスト。isInternalUrl が origin 完全一致であることを、既知の
// バイパス文字列で固定する (prefix 比較へ差し戻すと fail する)。
import { describe, expect, test } from "bun:test";
import { isInternalUrl } from "./urlPolicy";

const RENDERER_ORIGIN = "http://localhost:5173";

describe("isInternalUrl", () => {
  test("同一 origin は内部", () => {
    expect(isInternalUrl("http://localhost:5173/src/main.ts", RENDERER_ORIGIN)).toBe(true);
  });

  test("origin の後続にホストを継ぎ足した偽装は外部", () => {
    expect(isInternalUrl("http://localhost:5173.evil.example/", RENDERER_ORIGIN)).toBe(false);
  });

  test("renderer origin を userinfo に落とす偽装は外部", () => {
    expect(isInternalUrl("http://localhost:5173@evil.example/", RENDERER_ORIGIN)).toBe(false);
  });

  test("scheme 違い (https) は同一 host でも外部 (origin は scheme を含む)", () => {
    expect(isInternalUrl("https://localhost:5173/", RENDERER_ORIGIN)).toBe(false);
  });

  test("file: は renderer origin 不在 (packaged) でも内部", () => {
    expect(isInternalUrl("file:///Applications/Gozd.app/renderer/index.html", undefined)).toBe(
      true,
    );
  });

  test("parse 不能な文字列は外部側に倒す", () => {
    expect(isInternalUrl("not a url", RENDERER_ORIGIN)).toBe(false);
  });
});
