import { describe, expect, test } from "bun:test";
import { normalizePath } from "./pathUtils";

describe("normalizePath", () => {
  test(".. を解決する", () => {
    expect(normalizePath("apps/desktop/build/../src/main.ts")).toBe("apps/desktop/src/main.ts");
  });

  test("複数の .. を解決する", () => {
    expect(normalizePath("a/b/c/../../d")).toBe("a/d");
  });

  test(". を除去する", () => {
    expect(normalizePath("a/./b/./c")).toBe("a/b/c");
  });

  test("絶対パスの .. を解決する", () => {
    expect(normalizePath("/Users/foo/bar/../baz/main.js")).toBe("/Users/foo/baz/main.js");
  });

  test("絶対パスでルートを越える .. は無視する", () => {
    expect(normalizePath("/a/../../b")).toBe("/b");
  });

  test("相対パスの先頭 .. は保持する", () => {
    expect(normalizePath("../a")).toBe("../a");
    expect(normalizePath("a/../../b")).toBe("../b");
  });

  test("連続スラッシュを1つに畳む", () => {
    expect(normalizePath("a//b///c")).toBe("a/b/c");
    expect(normalizePath("/a//b")).toBe("/a/b");
  });

  test("末尾スラッシュを除去する", () => {
    expect(normalizePath("a/b/")).toBe("a/b");
    expect(normalizePath("/a/b/")).toBe("/a/b");
  });

  test("~ で始まるパスを正規化する", () => {
    expect(normalizePath("~/a/../b")).toBe("~/b");
  });

  test("ルートパスはそのまま返す", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("変更不要なパスはそのまま返す", () => {
    expect(normalizePath("a/b/c")).toBe("a/b/c");
    expect(normalizePath("/a/b/c")).toBe("/a/b/c");
  });
});
