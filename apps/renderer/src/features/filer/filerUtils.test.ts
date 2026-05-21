import { describe, expect, test } from "bun:test";
import {
  dirName,
  isDescendantOf,
  isRootPath,
  joinPath,
  pathForNativeRpc,
  sortEntries,
  toFileEntries,
  type FileEntry,
} from "./filerUtils";

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

describe("joinPath", () => {
  test("worktree 直下の親は先頭スラッシュなし", () => {
    expect(joinPath("", "name")).toBe("name");
  });

  test("通常の親は / で連結する", () => {
    expect(joinPath("dir", "name")).toBe("dir/name");
  });

  test("ネストした親も / で連結する", () => {
    expect(joinPath("a/b", "c")).toBe("a/b/c");
  });

  test("name が空文字でも先頭スラッシュは付かない", () => {
    expect(joinPath("", "")).toBe("");
  });
});

describe("isRootPath", () => {
  test("空文字列は root", () => {
    expect(isRootPath("")).toBe(true);
  });

  test("通常の relPath は root ではない", () => {
    expect(isRootPath("src")).toBe(false);
    expect(isRootPath("a/b")).toBe(false);
  });

  test(". は root ではない（Swift relDir SSOT に従い root は空文字のみ）", () => {
    expect(isRootPath(".")).toBe(false);
  });
});

describe("pathForNativeRpc", () => {
  test("root は . に置き換わる", () => {
    expect(pathForNativeRpc("")).toBe(".");
  });

  test("通常の relPath はそのまま", () => {
    expect(pathForNativeRpc("src")).toBe("src");
    expect(pathForNativeRpc("a/b")).toBe("a/b");
  });
});

describe("isDescendantOf", () => {
  test("root はあらゆる非ルート relPath の祖先扱い", () => {
    expect(isDescendantOf("src/foo.ts", "")).toBe(true);
    expect(isDescendantOf("a", "")).toBe(true);
  });

  test("ディレクトリ配下の relPath は配下扱い", () => {
    expect(isDescendantOf("src/foo.ts", "src")).toBe(true);
    expect(isDescendantOf("src/a/b.ts", "src/a")).toBe(true);
  });

  test("自分自身は配下扱いではない（厳密配下）", () => {
    expect(isDescendantOf("src", "src")).toBe(false);
  });

  test("root × root も厳密配下に従って自分自身扱い（false）", () => {
    expect(isDescendantOf("", "")).toBe(false);
  });

  test("prefix のみ一致する別 dir は配下扱いではない（/foo が /foobar の prefix にならない）", () => {
    expect(isDescendantOf("srcbar/foo.ts", "src")).toBe(false);
  });
});

describe("toFileEntries", () => {
  test("isIgnored: true を伝搬する", () => {
    const result = toFileEntries([{ name: "node_modules", type: "directory", isIgnored: true }]);
    expect(result[0]?.isIgnored).toBe(true);
  });

  test("isIgnored: false を伝搬する", () => {
    const result = toFileEntries([{ name: "src", type: "directory", isIgnored: false }]);
    expect(result[0]?.isIgnored).toBe(false);
  });

  test("type === 'directory' は isDirectory: true になる", () => {
    const result = toFileEntries([{ name: "src", type: "directory", isIgnored: false }]);
    expect(result[0]?.isDirectory).toBe(true);
  });

  test("type === 'file' は isDirectory: false になる", () => {
    const result = toFileEntries([{ name: "a.txt", type: "file", isIgnored: false }]);
    expect(result[0]?.isDirectory).toBe(false);
  });

  test("type === 'symlink' は isDirectory: false になる", () => {
    const result = toFileEntries([{ name: "link", type: "symlink", isIgnored: false }]);
    expect(result[0]?.isDirectory).toBe(false);
  });

  test("type === 'other' は isDirectory: false になる", () => {
    const result = toFileEntries([{ name: "fifo", type: "other", isIgnored: false }]);
    expect(result[0]?.isDirectory).toBe(false);
  });

  test("空配列を処理できる", () => {
    expect(toFileEntries([])).toEqual([]);
  });
});
