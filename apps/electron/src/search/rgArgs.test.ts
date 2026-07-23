// getRgArgs の引数マッピング契約。検索オプション → rg フラグの対応を固定する。

import { describe, expect, test } from "bun:test";
import { getRgArgs } from "./rgArgs";

describe("getRgArgs", () => {
  test("固定文字列検索は --fixed-strings + --ignore-case、パターンは --regexp の値", () => {
    const args = getRgArgs({ pattern: "foo" }, {});
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--ignore-case");
    expect(args).toContain("--json");
    expect(args.slice(-2)).toEqual(["--", "."]);
    const i = args.indexOf("--regexp");
    expect(args[i + 1]).toBe("foo");
  });

  test("正規表現検索は --fixed-strings を付けない", () => {
    const args = getRgArgs({ pattern: "fo+", isRegExp: true }, {});
    expect(args).not.toContain("--fixed-strings");
    expect(args).toContain("--regexp");
  });

  test("大文字小文字区別で --case-sensitive", () => {
    const args = getRgArgs({ pattern: "Foo", isCaseSensitive: true }, {});
    expect(args).toContain("--case-sensitive");
    expect(args).not.toContain("--ignore-case");
  });

  test("単語一致で --word-regexp", () => {
    const args = getRgArgs({ pattern: "foo", isWordMatch: true }, {});
    expect(args).toContain("--word-regexp");
  });

  test("** 始まり include（doubleStar）は !* を付けず直接 -g（descent 問題回避）", () => {
    const args = getRgArgs({ pattern: "x" }, { includes: ["**/foo/**"] });
    expect(args).not.toContain("!*");
    expect(args).toContain("**/foo/**");
  });

  test("** 以外の include は !* + 各パス階層を anchorGlob して re-include", () => {
    const args = getRgArgs({ pattern: "x" }, { includes: ["src/foo"] });
    expect(args).toContain("!*");
    // spreadGlobComponents(src/foo)=[src, src/foo] を anchorGlob して root 相対に
    expect(args).toContain("/src");
    expect(args).toContain("/src/foo");
  });

  test("exclude は anchorGlob して ! 前置（** はそのまま、素の語は / 前置）", () => {
    const args = getRgArgs({ pattern: "x" }, { excludes: ["**/dist/**", "build"] });
    expect(args).toContain("!**/dist/**");
    expect(args).toContain("!/build");
  });

  test("既定除外で .git 等を常に外す（VS Code files.exclude default 相当）", () => {
    // --hidden の副作用で .git に降りるのを打ち消す。指定除外が無くても常に付く
    const args = getRgArgs({ pattern: "x" }, {});
    for (const glob of ["!**/.git", "!**/.svn", "!**/.hg", "!**/.DS_Store", "!**/Thumbs.db"]) {
      expect(args).toContain(glob);
    }
  });

  test("gitignore はデフォルト尊重（--no-ignore を付けない）", () => {
    expect(getRgArgs({ pattern: "x" }, {})).not.toContain("--no-ignore");
    expect(getRgArgs({ pattern: "x" }, { useIgnoreFiles: false })).toContain("--no-ignore");
  });

  test("文脈行で --before/--after-context", () => {
    const args = getRgArgs({ pattern: "x" }, { surroundingContext: 2 });
    expect(args).toContain("--before-context");
    expect(args).toContain("--after-context");
  });
});
