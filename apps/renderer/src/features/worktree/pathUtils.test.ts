import { describe, expect, test } from "bun:test";
import {
  joinAbsRel,
  normalizeAbsolute,
  normalizeRelative,
  type PathTarget,
  pathTargetEquals,
} from "./pathUtils";

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

describe("pathTargetEquals", () => {
  function rel(relPath: string): PathTarget {
    return { kind: "worktreeRelative", relPath };
  }
  function abs(absPath: string): PathTarget {
    return { kind: "absolute", absPath };
  }

  test("同 kind 同 path (worktreeRelative) は true", () => {
    expect(pathTargetEquals(rel("a/b.md"), rel("a/b.md"))).toBe(true);
  });

  test("同 kind 同 path (absolute) は true", () => {
    expect(pathTargetEquals(abs("/x/y.md"), abs("/x/y.md"))).toBe(true);
  });

  test("同 kind 異 path (worktreeRelative) は false", () => {
    expect(pathTargetEquals(rel("a.md"), rel("b.md"))).toBe(false);
  });

  test("同 kind 異 path (absolute) は false", () => {
    expect(pathTargetEquals(abs("/a.md"), abs("/b.md"))).toBe(false);
  });

  test("異 kind は path が同名でも false", () => {
    expect(pathTargetEquals(rel("a.md"), abs("/a.md"))).toBe(false);
    expect(pathTargetEquals(abs("/a.md"), rel("a.md"))).toBe(false);
  });
});

describe("joinAbsRel", () => {
  test("dir + relPath を / で結合する", () => {
    expect(joinAbsRel("/Users/foo/repo", "src/main.ts")).toBe("/Users/foo/repo/src/main.ts");
  });

  test("relPath が深いネストでも結合する", () => {
    expect(joinAbsRel("/abs/dir", "a/b/c/d.ts")).toBe("/abs/dir/a/b/c/d.ts");
  });

  test("relPath が空のとき dir をそのまま返す (末尾 / を作らない)", () => {
    expect(joinAbsRel("/Users/foo/repo", "")).toBe("/Users/foo/repo");
  });
});
