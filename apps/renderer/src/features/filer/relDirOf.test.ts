import { describe, expect, test } from "bun:test";
import { relDirOf } from "./relDirOf";

describe("relDirOf", () => {
  // Swift `FSWatchRegistry.relativeDir(path:dir:dirWithSlash:)` の出力と一致させる境界。
  // 表現が乖離すると fsChange.relDir との `===` 比較が永久に外れる。
  test.each([
    ["worktree 直下ファイルは空文字", "foo.ts", ""],
    ["拡張子なしの直下ファイルも空文字", "Makefile", ""],
    ["1 階層下は親 dir", "src/foo.ts", "src"],
    ["多階層下は末尾スラッシュなしの dir", "apps/renderer/src/foo.ts", "apps/renderer/src"],
    ["空文字入力は空文字", "", ""],
  ])("%s: %s → %p", (_title, input, expected) => {
    expect(relDirOf(input)).toBe(expected);
  });
});
