import { describe, expect, test } from "bun:test";
import { findAbsolutePathMatches } from "./findAbsolutePathMatches";
import { findRelativePaths } from "./findRelativePaths";
import { clipMatchToCurrentLine } from "./useFilePathLinkProvider";

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

  test("home prefix の境界をまたぐ別ユーザー名は home 経路で拾わず、generic `/` 経路で absolute として検出される", () => {
    const matches = findAbsolutePathMatches("/Users/me_other/x.ts", dirPrefix, homeDir);
    expect(matches.map((m) => m.selection)).toEqual([
      { kind: "absolute", absPath: "/Users/me_other/x.ts" },
    ]);
  });

  test("テキスト中の複数の絶対パスを順に検出する", () => {
    const text = "see /Users/me/proj/src/a.ts and /Users/me/elsewhere/b.ts";
    const matches = findAbsolutePathMatches(text, dirPrefix, homeDir);
    expect(matches.map((m) => m.selection)).toEqual([
      { kind: "worktreeRelative", relPath: "src/a.ts" },
      { kind: "absolute", absPath: "/Users/me/elsewhere/b.ts" },
    ]);
  });

  test("homeDir が空なら `~/` も homePrefix も拾わないが、generic `/` 経路で絶対パスは検出される", () => {
    const matches = findAbsolutePathMatches("~/foo.ts and /Users/me/bar.ts", "/tmp/proj/", "");
    expect(matches.map((m) => m.selection)).toEqual([
      { kind: "absolute", absPath: "/Users/me/bar.ts" },
    ]);
  });

  describe("generic `/` 経路（worktree / home 外の絶対パス）", () => {
    test("`/tmp/...` を absolute として検出する", () => {
      const matches = findAbsolutePathMatches("see /tmp/pr704-body.md now", dirPrefix, homeDir);
      expect(matches.map((m) => m.selection)).toEqual([
        { kind: "absolute", absPath: "/tmp/pr704-body.md" },
      ]);
    });

    test("`/var/folders/...` のような macOS TMPDIR も検出する", () => {
      const matches = findAbsolutePathMatches(
        "wrote /var/folders/abc/xyz/T/tmp.log",
        dirPrefix,
        homeDir,
      );
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/var/folders/abc/xyz/T/tmp.log",
      });
    });

    test("`/usr/local/bin/foo` のようなシステムパスも検出する", () => {
      const matches = findAbsolutePathMatches("path: /usr/local/bin/foo", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({
        kind: "absolute",
        absPath: "/usr/local/bin/foo",
      });
    });

    test("URL の path 部分の `/` は boundary check で弾かれる", () => {
      const matches = findAbsolutePathMatches(
        "see https://example.com/path/to/foo for details",
        dirPrefix,
        homeDir,
      );
      expect(matches).toEqual([]);
    });

    test("`/tmp/foo.md` の直後に行番号 `:42` が続いた場合も検出する", () => {
      const matches = findAbsolutePathMatches("open /tmp/foo.md:42", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "/tmp/foo.md" });
      expect(matches[0]?.lineNumber).toBe(42);
    });

    test("dirPrefix 配下のパスは generic より優先され worktreeRelative になる", () => {
      const matches = findAbsolutePathMatches(
        "/Users/me/proj/src/a.ts and /tmp/x.ts",
        dirPrefix,
        homeDir,
      );
      expect(matches.map((m) => m.selection)).toEqual([
        { kind: "worktreeRelative", relPath: "src/a.ts" },
        { kind: "absolute", absPath: "/tmp/x.ts" },
      ]);
    });

    test("`/etc` のような単一セグメントも absolute として返す（実在検証は契約外）", () => {
      const matches = findAbsolutePathMatches("cd /etc", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "/etc" });
    });

    test("root `/` 単独は path として構造的に意味を持たないので拾わない (VSCode 整合)", () => {
      const matches = findAbsolutePathMatches("cd /", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("`/` の後に PATH_TERMINATORS が直接続くケース (`/ `) も拾わない", () => {
      const matches = findAbsolutePathMatches("/ then text", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("単一セグメント `/etc` の後に `/` 単独が続いても、先頭の単一セグメントだけ拾い後続の `/` 単独は拾わない", () => {
      const matches = findAbsolutePathMatches("see /etc and /", dirPrefix, homeDir);
      expect(matches.map((m) => m.selection)).toEqual([{ kind: "absolute", absPath: "/etc" }]);
    });

    test("`~/foo.ts` の `/foo.ts` 部分は generic 経路では拾わない（tilde 経路の責務）", () => {
      const matches = findAbsolutePathMatches("~/foo.ts", dirPrefix, homeDir);
      expect(matches.map((m) => m.selection)).toEqual([
        { kind: "absolute", absPath: "/Users/me/foo.ts" },
      ]);
    });

    test("`x://abs/path` のような scheme 形式は `:` 直後の `/` も連続 `/` も起点にせず、結果として拾わない", () => {
      // 先頭 `x` は IDENTIFIER_CHAR で hasBoundaryBefore が false（URL scheme `x:` の一部）。
      // `:` 直後の `/` は除外規律 prev === ":" で skip、続く `/` も prev === "/" で skip。
      // `abs/path` の `/` は IDENTIFIER_CHAR 直後で boundary 不成立。
      const matches = findAbsolutePathMatches("x://abs/path", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("行頭 `//abs/path` は VSCode の `(\\/+ Char+)+` 整合で先頭 `/` を起点に全体を 1 path として拾う", () => {
      // VSCode unixLocalLinkClause は連続 slash を path separator として許容する。
      // 行頭 `/` は直前文字なし (prev="") で除外集合に該当せず boundary 成立、findPathEnd は
      // PATH_TERMINATORS に `/` を含まないので `//abs/path` 全体を 1 マッチで消費する。
      const matches = findAbsolutePathMatches("//abs/path", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "//abs/path" });
    });

    test("空白直後の `//abs/path` も同様に拾う（先頭が ` ` で boundary 成立）", () => {
      const matches = findAbsolutePathMatches("see //abs/path now", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "//abs/path" });
    });

    test("`--path=/foo` のような cli option 形式は `=` 直後の `/` で boundary 成立し拾う", () => {
      const matches = findAbsolutePathMatches("run --path=/tmp/foo", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "/tmp/foo" });
    });

    test("`///` 単独は `/` 以外の path 文字を持たないので拾わない (VSCode `Char+` 要求と等価)", () => {
      const matches = findAbsolutePathMatches("///", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("`////` のような複数連続 slash 単独も拾わない", () => {
      const matches = findAbsolutePathMatches("////", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("`/foo///bar` のような path 文字を含む連続 slash は拾う (`Char+` 要求を満たす)", () => {
      const matches = findAbsolutePathMatches("/foo///bar", dirPrefix, homeDir);
      expect(matches[0]?.selection).toEqual({ kind: "absolute", absPath: "/foo///bar" });
    });

    test("`see ///` のように行末が連続 slash で終わるケースも拾わない", () => {
      const matches = findAbsolutePathMatches("see ///", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });

    test("`/// foo.txt` のように連続 slash の後に PATH_TERMINATORS (空白) で停止する場合、先頭 `///` 部分は拾わない", () => {
      // findPathEnd は 空白で停止するため text.slice(0, 3) = "///" が hasNonSlashChar で skip。
      // 後続 "foo.txt" は generic 経路の単独セグメントとしては起点にならない (boundary は ` ` 直後の
      // `f` 始まりだが、generic 経路は `/` 始まりの absolute 検出のため、ここに該当しない)。
      const matches = findAbsolutePathMatches("/// foo.txt", dirPrefix, homeDir);
      expect(matches).toEqual([]);
    });
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

describe("clipMatchToCurrentLine", () => {
  const dirPrefix = "/Users/me/proj/";
  const homeDir = "/Users/me";

  // collectIndentedBlock が現在行 ("very long") と継続行 ("/tmp/foo.md") を結合し、
  // 現在行起点で string 範囲を再射影する経路を境界で検証する。
  // joinedText = "very long /tmp/foo.md continuation", currentLineOffset/Length は現在行を指す。

  test("match が現在行範囲内に完全に含まれるとき、現在行起点の linkStart/linkEnd を返す", () => {
    const joinedText = "see /tmp/foo.md now";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    const clipped = clipMatchToCurrentLine(match, 0, joinedText.length);
    expect(clipped).toEqual({ linkStart: 4, linkEnd: 15 });
  });

  test("match が現在行範囲の前 (継続行側) に完全にあるとき null を返す", () => {
    // 現在行: 結合テキストの後半 "continuation" のみ。前半 "/tmp/foo.md" は現在行範囲外。
    const joinedText = "/tmp/foo.md continuation";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    const currentLineOffset = "/tmp/foo.md ".length; // 12
    const currentLineLength = "continuation".length;
    const clipped = clipMatchToCurrentLine(match, currentLineOffset, currentLineLength);
    expect(clipped).toBeNull();
  });

  test("match が現在行範囲の後にあるとき null を返す", () => {
    // 現在行: 結合テキストの前半 "see " のみ。後半 "/tmp/foo.md" は現在行範囲外。
    const joinedText = "see /tmp/foo.md";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    const currentLineOffset = 0;
    const currentLineLength = "see ".length; // 4
    const clipped = clipMatchToCurrentLine(match, currentLineOffset, currentLineLength);
    expect(clipped).toBeNull();
  });

  test("match が現在行範囲を跨いで開始 (継続行起点) するとき、現在行内に収まる部分だけを返す", () => {
    // joinedText = "/tmp/foo.md tail", 現在行が "tail" のみ (currentLineOffset=12)。
    // match.idx=0 (継続行), match.totalEnd=11 で、現在行範囲 [12,16) と重ならず null。
    // 跨ぐケースを作るには match を継続行から現在行へ伸ばす必要がある。
    // joinedText = "/tmp/foo-and-bar.md" を現在行 "-and-bar.md" (offset=8) で受ける。
    const joinedText = "/tmp/foo-and-bar.md";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    expect(match.idx).toBe(0);
    expect(match.totalEnd).toBe(joinedText.length);
    const currentLineOffset = "/tmp/foo".length; // 8、現在行が "-and-bar.md" の 11 文字
    const currentLineLength = "-and-bar.md".length; // 11
    const clipped = clipMatchToCurrentLine(match, currentLineOffset, currentLineLength);
    expect(clipped).toEqual({ linkStart: 0, linkEnd: 11 });
  });

  test("match が現在行範囲を跨いで終了 (現在行から継続行へ伸びる) するとき、現在行内に収まる部分だけを返す", () => {
    // joinedText = "/tmp/foo.md", 現在行が "/tmp" のみ (offset=0, length=4)。
    // match.idx=0, match.totalEnd=11 で、現在行 [0,4) に切り取られる。
    const joinedText = "/tmp/foo.md";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    const currentLineOffset = 0;
    const currentLineLength = 4;
    const clipped = clipMatchToCurrentLine(match, currentLineOffset, currentLineLength);
    expect(clipped).toEqual({ linkStart: 0, linkEnd: 4 });
  });

  test("currentLineEnd 境界 ちょうど (match.idx === currentLineEnd) で null を返す", () => {
    const joinedText = "ab /tmp/foo.md";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    expect(match.idx).toBe(3);
    // 現在行 [0,3) で match.idx=3 → 範囲外
    const clipped = clipMatchToCurrentLine(match, 0, 3);
    expect(clipped).toBeNull();
  });

  test("currentLineOffset 境界 (match.totalEnd === currentLineOffset) で null を返す", () => {
    const joinedText = "/tmp/foo.md xy";
    const [match] = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);
    expect(match.totalEnd).toBe(11);
    // 現在行 [11,14) で match.totalEnd=11 → 範囲外
    const clipped = clipMatchToCurrentLine(match, 11, 3);
    expect(clipped).toBeNull();
  });
});
