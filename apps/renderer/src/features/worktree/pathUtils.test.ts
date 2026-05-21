import { describe, expect, test } from "bun:test";
import { normalizeAbsolute, normalizeRelative } from "./pathUtils";

describe("normalizeRelative", () => {
  test(".. を解決する", () => {
    expect(normalizeRelative("apps/desktop/build/../src/main.ts")).toBe("apps/desktop/src/main.ts");
  });

  test("複数の .. を解決する", () => {
    expect(normalizeRelative("a/b/c/../../d")).toBe("a/d");
  });

  test(". を除去する", () => {
    expect(normalizeRelative("a/./b/./c")).toBe("a/b/c");
  });

  test("先頭 .. は保持する", () => {
    expect(normalizeRelative("../a")).toBe("../a");
    expect(normalizeRelative("a/../../b")).toBe("../b");
  });

  test("連続スラッシュを1つに畳む", () => {
    expect(normalizeRelative("a//b///c")).toBe("a/b/c");
  });

  test("末尾スラッシュを除去する", () => {
    expect(normalizeRelative("a/b/")).toBe("a/b");
  });

  test("変更不要なパスはそのまま返す", () => {
    expect(normalizeRelative("a/b/c")).toBe("a/b/c");
  });
});

describe("normalizeAbsolute", () => {
  test(".. を解決する", () => {
    expect(normalizeAbsolute("/Users/foo/bar/../baz/main.js")).toBe("/Users/foo/baz/main.js");
  });

  test("ルートを越える .. は無視する", () => {
    expect(normalizeAbsolute("/a/../../b")).toBe("/b");
  });

  test(". を除去する", () => {
    expect(normalizeAbsolute("/a/./b/./c")).toBe("/a/b/c");
  });

  test("連続スラッシュを1つに畳む", () => {
    expect(normalizeAbsolute("/a//b")).toBe("/a/b");
  });

  test("末尾スラッシュを除去する", () => {
    expect(normalizeAbsolute("/a/b/")).toBe("/a/b");
  });

  test("ルートパスはそのまま返す", () => {
    expect(normalizeAbsolute("/")).toBe("/");
  });

  test("変更不要なパスはそのまま返す", () => {
    expect(normalizeAbsolute("/a/b/c")).toBe("/a/b/c");
  });
});
