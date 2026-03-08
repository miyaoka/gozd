import { describe, expect, test } from "bun:test";
import { dirName, sortEntries, type FileEntry } from "./filer-utils";

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
