import { describe, expect, test } from "bun:test";
import { findAbsolutePathMatches } from "./findAbsolutePathMatches";
import { findRelativePaths } from "./findRelativePaths";

describe("findRelativePaths", () => {
  test("基本的な相対パスを検出する", () => {
    const results = findRelativePaths("src/main.ts");
    expect(results).toEqual([{ path: "src/main.ts", startIdx: 0, endIdx: 11 }]);
  });

  test("深いパスを検出する", () => {
    const [result] = findRelativePaths("apps/renderer/src/features/filer/filerUtils.ts");
    expect(result?.path).toBe("apps/renderer/src/features/filer/filerUtils.ts");
  });

  test("複数ドットの拡張子を検出する（.test.ts）", () => {
    const [result] = findRelativePaths("src/features/filer/filerUtils.test.ts");
    expect(result?.path).toBe("src/features/filer/filerUtils.test.ts");
  });

  test(".spec.tsx を検出する", () => {
    const [result] = findRelativePaths("src/App.spec.tsx");
    expect(result?.path).toBe("src/App.spec.tsx");
  });

  test(".d.ts を検出する", () => {
    const [result] = findRelativePaths("src/types/env.d.ts");
    expect(result?.path).toBe("src/types/env.d.ts");
  });

  test("@ プレフィックスのパスを検出する", () => {
    const [result] = findRelativePaths("@gozd/shared/result.ts");
    expect(result?.path).toBe("@gozd/shared/result.ts");
  });

  test("テキスト中の複数パスを検出する", () => {
    const results = findRelativePaths("modified: src/a.ts and src/b.vue");
    expect(results.map((r) => r.path)).toEqual(["src/a.ts", "src/b.vue"]);
  });

  test("拡張子なしのパスは検出しない", () => {
    expect(findRelativePaths("src/features/filer")).toEqual([]);
  });

  test("単一セグメントのファイルは検出しない", () => {
    expect(findRelativePaths("main.ts")).toEqual([]);
  });

  test("行番号付きパスを検出する", () => {
    const results = findRelativePaths("src/main.ts:30");
    expect(results).toEqual([{ path: "src/main.ts", startIdx: 0, endIdx: 14, lineNumber: 30 }]);
  });

  test("行番号なしのパスには lineNumber が含まれない", () => {
    const [result] = findRelativePaths("src/main.ts");
    expect(result?.lineNumber).toBeUndefined();
  });

  test("テキスト中の行番号付きパスを検出する", () => {
    const results = findRelativePaths("error at src/app.vue:25 and src/main.ts:100");
    expect(results).toEqual([
      { path: "src/app.vue", startIdx: 9, endIdx: 23, lineNumber: 25 },
      { path: "src/main.ts", startIdx: 28, endIdx: 43, lineNumber: 100 },
    ]);
  });
});

describe("findAbsolutePathMatches", () => {
  const dirPrefix = "/Users/me/proj/";
  const homeDir = "/Users/me";

  test("worktree 内パスは dirPrefix を剥がした相対パスで返す", () => {
    const matches = findAbsolutePathMatches("/Users/me/proj/src/a.ts", dirPrefix, homeDir);
    expect(matches).toEqual([
      { idx: 0, totalEnd: 23, selectPath: "src/a.ts", lineNumber: undefined },
    ]);
  });

  test("worktree 外の絶対パスは絶対パスのまま返す", () => {
    const matches = findAbsolutePathMatches("/Users/me/elsewhere/b.ts", dirPrefix, homeDir);
    expect(matches[0]?.selectPath).toBe("/Users/me/elsewhere/b.ts");
  });

  test("`~/` はホームディレクトリに展開した絶対パスで返す", () => {
    const matches = findAbsolutePathMatches("~/elsewhere/c.ts", dirPrefix, homeDir);
    expect(matches[0]?.selectPath).toBe("/Users/me/elsewhere/c.ts");
  });

  test("パス末尾の `:行番号` を読み取る", () => {
    const matches = findAbsolutePathMatches("/Users/me/elsewhere/d.ts:42", dirPrefix, homeDir);
    expect(matches[0]?.lineNumber).toBe(42);
    expect(matches[0]?.totalEnd).toBe("/Users/me/elsewhere/d.ts:42".length);
  });

  test("dir 名に空白を含んでも prefix 内で切れない", () => {
    // homeDir 外の dir なので homePrefix では拾わない
    const dir = "/tmp/My Project/repo/";
    const matches = findAbsolutePathMatches("build at /tmp/My Project/repo/src/x.ts done", dir, "");
    expect(matches[0]?.selectPath).toBe("src/x.ts");
  });

  test("dir 名に括弧を含んでも prefix 内で切れない", () => {
    const dir = "/tmp/foo(bar)/repo/";
    const matches = findAbsolutePathMatches("/tmp/foo(bar)/repo/src/y.ts", dir, "");
    expect(matches[0]?.selectPath).toBe("src/y.ts");
  });

  test("同 idx で dir/home が衝突した場合 dir 相対化を優先する", () => {
    // dirPrefix === homePrefix のとき、両方が idx=0 で match する。
    // prefixLen 降順 tie-break により dir が勝ち、selectPath は相対化される。
    const matches = findAbsolutePathMatches("/Users/me/src/z.ts", "/Users/me/", "/Users/me");
    expect(matches[0]?.selectPath).toBe("src/z.ts");
  });

  test("home prefix の境界をまたぐ別ユーザー名は誤検出しない", () => {
    // homePrefix は `/Users/me/`。`/Users/me_other/...` は match しない
    const matches = findAbsolutePathMatches("/Users/me_other/x.ts", dirPrefix, homeDir);
    expect(matches).toEqual([]);
  });

  test("テキスト中の複数の絶対パスを順に検出する", () => {
    const text = "see /Users/me/proj/src/a.ts and /Users/me/elsewhere/b.ts";
    const matches = findAbsolutePathMatches(text, dirPrefix, homeDir);
    expect(matches.map((m) => m.selectPath)).toEqual(["src/a.ts", "/Users/me/elsewhere/b.ts"]);
  });

  test("homeDir が空なら `~/` も homePrefix も検出しない", () => {
    // resolveHomeDir が `/Users/<user>` を抽出できないケース（dirPrefix が `/tmp/...` 等）
    const matches = findAbsolutePathMatches("~/foo.ts and /Users/me/bar.ts", "/tmp/proj/", "");
    expect(matches).toEqual([]);
  });
});
