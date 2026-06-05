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

  test("行番号 `:0` は SSOT (parseLineNumberSuffix) で undefined に倒す", () => {
    const [result] = findRelativePaths("src/main.ts:0");
    expect(result?.lineNumber).toBeUndefined();
  });

  test("Number.MAX_SAFE_INTEGER を超える行番号も undefined", () => {
    const [result] = findRelativePaths("src/main.ts:99999999999999999999");
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

  test("worktree 内パスは dirPrefix を剥がした worktreeRelative selection で返す", () => {
    const matches = findAbsolutePathMatches("/Users/me/proj/src/a.ts", dirPrefix, homeDir);
    expect(matches).toEqual([
      {
        idx: 0,
        totalEnd: 23,
        selection: { kind: "worktreeRelative", relPath: "src/a.ts" },
        lineNumber: undefined,
      },
    ]);
  });

  test("worktree 外の絶対パスは absolute selection で返す", () => {
    const matches = findAbsolutePathMatches("/Users/me/elsewhere/b.ts", dirPrefix, homeDir);
    expect(matches[0]?.selection).toEqual({
      kind: "absolute",
      absPath: "/Users/me/elsewhere/b.ts",
    });
  });

  test("`~/` はホームディレクトリに展開した absolute selection で返す", () => {
    const matches = findAbsolutePathMatches("~/elsewhere/c.ts", dirPrefix, homeDir);
    expect(matches[0]?.selection).toEqual({
      kind: "absolute",
      absPath: "/Users/me/elsewhere/c.ts",
    });
  });

  test("パス末尾の `:行番号` を読み取る", () => {
    const matches = findAbsolutePathMatches("/Users/me/elsewhere/d.ts:42", dirPrefix, homeDir);
    expect(matches[0]?.lineNumber).toBe(42);
    expect(matches[0]?.totalEnd).toBe("/Users/me/elsewhere/d.ts:42".length);
  });

  test("`#` で終端する（shell コメント / fragment がパスに混入しない）", () => {
    const matches = findAbsolutePathMatches(
      "/Users/me/elsewhere/b8i8z99z7.txt# comment",
      dirPrefix,
      homeDir,
    );
    expect(matches[0]?.selection).toEqual({
      kind: "absolute",
      absPath: "/Users/me/elsewhere/b8i8z99z7.txt",
    });
  });

  test.each([
    ["|", "cat /Users/me/elsewhere/a.txt|grep x"],
    ["&", "run /Users/me/elsewhere/a.txt&"],
    ["`", "echo /Users/me/elsewhere/a.txt`x`"],
    ["$", "/Users/me/elsewhere/a.txt$VAR"],
    ["<", "/Users/me/elsewhere/a.txt<in"],
    ["!", "/Users/me/elsewhere/a.txt!cmd"],
    ["*", "/Users/me/elsewhere/a.txt*glob"],
    ["?", "/Users/me/elsewhere/a.txt?q"],
    ["\\", "/Users/me/elsewhere/a.txt\\esc"],
    ["{", "/Users/me/elsewhere/a.txt{x"],
    ["[", "/Users/me/elsewhere/a.txt[x"],
  ])("シェルメタ文字 `%s` で終端する", (_sep, text) => {
    const matches = findAbsolutePathMatches(text, dirPrefix, homeDir);
    expect(matches[0]?.selection).toEqual({
      kind: "absolute",
      absPath: "/Users/me/elsewhere/a.txt",
    });
  });

  test("dir 名に空白を含んでも prefix 内で切れない", () => {
    const dir = "/tmp/My Project/repo/";
    const matches = findAbsolutePathMatches("build at /tmp/My Project/repo/src/x.ts done", dir, "");
    expect(matches[0]?.selection).toEqual({ kind: "worktreeRelative", relPath: "src/x.ts" });
  });

  test("dir 名に括弧を含んでも prefix 内で切れない", () => {
    const dir = "/tmp/foo(bar)/repo/";
    const matches = findAbsolutePathMatches("/tmp/foo(bar)/repo/src/y.ts", dir, "");
    expect(matches[0]?.selection).toEqual({ kind: "worktreeRelative", relPath: "src/y.ts" });
  });

  test("同 idx で dir/home が衝突した場合 dir 相対化を優先する", () => {
    const matches = findAbsolutePathMatches("/Users/me/src/z.ts", "/Users/me/", "/Users/me");
    expect(matches[0]?.selection).toEqual({ kind: "worktreeRelative", relPath: "src/z.ts" });
  });

  test("home prefix の境界をまたぐ別ユーザー名は誤検出しない", () => {
    const matches = findAbsolutePathMatches("/Users/me_other/x.ts", dirPrefix, homeDir);
    expect(matches).toEqual([]);
  });

  test("テキスト中の複数の絶対パスを順に検出する", () => {
    const text = "see /Users/me/proj/src/a.ts and /Users/me/elsewhere/b.ts";
    const matches = findAbsolutePathMatches(text, dirPrefix, homeDir);
    expect(matches.map((m) => m.selection)).toEqual([
      { kind: "worktreeRelative", relPath: "src/a.ts" },
      { kind: "absolute", absPath: "/Users/me/elsewhere/b.ts" },
    ]);
  });

  test("homeDir が空なら `~/` も homePrefix も検出しない", () => {
    const matches = findAbsolutePathMatches("~/foo.ts and /Users/me/bar.ts", "/tmp/proj/", "");
    expect(matches).toEqual([]);
  });

  describe("境界条件", () => {
    test("dirPrefix 単独 (末尾 / のみ) は relPath が空になり結果から落ちる", () => {
      const matches = findAbsolutePathMatches("/Users/me/proj/", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("行番号 `:0` は consume するが lineNumber は undefined", () => {
      const matches = findAbsolutePathMatches("/Users/me/proj/a.ts:0", dirPrefix, homeDir);
      expect(matches[0]?.lineNumber).toBeUndefined();
      expect(matches[0]?.totalEnd).toBe("/Users/me/proj/a.ts:0".length);
    });

    test("safe integer 内の大きな行番号はそのまま返す", () => {
      const matches = findAbsolutePathMatches(
        "/Users/me/proj/a.ts:99999999999",
        dirPrefix,
        homeDir,
      );
      expect(matches[0]?.lineNumber).toBe(99999999999);
    });

    test("Number.MAX_SAFE_INTEGER を超える行番号は精度損失するため undefined", () => {
      const matches = findAbsolutePathMatches(
        "/Users/me/proj/a.ts:99999999999999999999",
        dirPrefix,
        homeDir,
      );
      expect(matches[0]?.lineNumber).toBeUndefined();
    });

    test("`~/:42` のように tilde 直後が PATH_TERMINATORS の場合、homeDir 自体を absolute selection として返す", () => {
      const matches = findAbsolutePathMatches("~/:42", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "/Users/me/" });
      expect(matches[0]?.lineNumber).toBe(42);
    });
  });

  describe("token boundary", () => {
    test("URL の path 部分にある `/Users/<user>/...` は誤検出しない", () => {
      const matches = findAbsolutePathMatches(
        "see https://example.com/Users/me/foo.ts for details",
        dirPrefix,
        homeDir,
      );
      expect(matches).toEqual([]);
    });

    test("行頭の絶対パスは boundary 成立で検出される", () => {
      const matches = findAbsolutePathMatches("/Users/me/elsewhere/x.ts", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/Users/me/elsewhere/x.ts",
      });
    });

    test("空白直後の絶対パスも boundary 成立で検出される", () => {
      const matches = findAbsolutePathMatches(
        "open /Users/me/elsewhere/x.ts now",
        dirPrefix,
        homeDir,
      );
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/Users/me/elsewhere/x.ts",
      });
    });

    test("`[/path]` のような bracket 始まりも boundary が立って検出される", () => {
      const matches = findAbsolutePathMatches("[/Users/me/elsewhere/foo.ts]", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/Users/me/elsewhere/foo.ts",
      });
    });

    test("`{/path}` のような curly 始まりも検出される", () => {
      const matches = findAbsolutePathMatches("{/Users/me/elsewhere/foo.ts}", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/Users/me/elsewhere/foo.ts",
      });
    });

    test("`</path>` のような angle bracket 始まりも検出される", () => {
      const matches = findAbsolutePathMatches("</Users/me/elsewhere/foo.ts>", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/Users/me/elsewhere/foo.ts",
      });
    });
  });
});
