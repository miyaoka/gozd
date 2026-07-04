import { describe, expect, test } from "bun:test";
import { ghRefForIssue, ghRefForPr, ghRefLabel } from "./helpers";

describe("ghRef helpers", () => {
  test("ghRefForPr / ghRefForIssue は永続化互換の kind 文字列を生成する", () => {
    // tasks.json は merge まで Swift 版 gozd と共有するため、この文字列は proto3 JSON の
    // enum 名から変えてはいけない（変えると Swift 側 parse 失敗 → task データ reinit）
    expect(ghRefForPr(42)).toEqual({ kind: "GH_REF_KIND_PR", number: 42 });
    expect(ghRefForIssue(7)).toEqual({ kind: "GH_REF_KIND_ISSUE", number: 7 });
  });

  test("ghRefLabel は種別付き表示ラベルを返す", () => {
    expect(ghRefLabel(ghRefForPr(42))).toBe("PR #42");
    expect(ghRefLabel(ghRefForIssue(7))).toBe("Issue #7");
  });
});
