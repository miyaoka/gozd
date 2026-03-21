import { describe, expect, test } from "bun:test";
import { dirName, normalizePath, sortEntries, type FileEntry } from "./filerUtils";

describe("dirName", () => {
  test("パスの末尾をディレクトリ名として返す", () => {
    expect(dirName("/path/to/project")).toBe("project");
  });

  test("スラッシュを含まないパスはそのまま返す", () => {
    expect(dirName("project")).toBe("project");
  });

  test("ルートパスは空文字を返す", () => {
    expect(dirName("/")).toBe("");
  });
});

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

describe("sortEntries", () => {
  const file = (name: string): FileEntry => ({ name, isDirectory: false, isIgnored: false });
  const dir = (name: string): FileEntry => ({ name, isDirectory: true, isIgnored: false });

  test("ディレクトリがファイルより先に来る", () => {
    const entries = [file("a.txt"), dir("src")];
    const sorted = sortEntries(entries);
    expect(sorted[0]?.name).toBe("src");
    expect(sorted[1]?.name).toBe("a.txt");
  });

  test("同種内では名前順にソートする", () => {
    const entries = [file("c.txt"), file("a.txt"), file("b.txt")];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("ディレクトリ同士も名前順にソートする", () => {
    const entries = [dir("src"), dir("docs"), dir("apps")];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["apps", "docs", "src"]);
  });

  test("元の配列を変更しない", () => {
    const entries = [file("b.txt"), file("a.txt")];
    const original = [...entries];
    sortEntries(entries);
    expect(entries).toEqual(original);
  });

  test("空配列を処理できる", () => {
    expect(sortEntries([])).toEqual([]);
  });
});
