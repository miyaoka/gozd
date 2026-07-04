// gitDiff の pure parser test + 実 git での統合テスト。
// line counting 規約（末尾改行の扱い）は renderer の絶対座標計算の SSOT なので契約を固定する。

import { describe, expect, test } from "bun:test";
import {
  countDiffLines,
  diffHunks,
  expandDiffLines,
  parseUnifiedDiffHunks,
  splitDiffLines,
} from "./gitDiff";

describe("countDiffLines / splitDiffLines (git line counting 規約)", () => {
  test("空文字 = 0 行", () => {
    expect(countDiffLines("")).toBe(0);
    expect(splitDiffLines("")).toEqual([]);
  });

  test("末尾 \\n 有り = 終端付き行の数", () => {
    expect(countDiffLines("a\nb\n")).toBe(2);
    expect(splitDiffLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("末尾 \\n 無し = 最終行（No newline 参照行）を含む", () => {
    expect(countDiffLines("a\nb")).toBe(2);
    expect(splitDiffLines("a\nb")).toEqual(["a", "b"]);
  });
});

describe("parseUnifiedDiffHunks", () => {
  test("hunk header と各 line kind を構造化する", () => {
    const text = [
      "diff --git a/a b/b",
      "index 0000000..1111111 100644",
      "--- a/a",
      "+++ b/b",
      "@@ -1,3 +1,4 @@",
      " ctx",
      "-removed",
      "+added1",
      "+added2",
      " ctx2",
      "",
    ].join("\n");
    const hunks = parseUnifiedDiffHunks(text);
    expect(hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          { kind: "context", text: "ctx" },
          { kind: "removed", text: "removed" },
          { kind: "added", text: "added1" },
          { kind: "added", text: "added2" },
          { kind: "context", text: "ctx2" },
        ],
      },
    ]);
  });

  test("count 省略 header（@@ -1 +1 @@）は 1 として扱う", () => {
    const hunks = parseUnifiedDiffHunks("@@ -1 +1 @@\n-a\n+b\n");
    expect(hunks[0].oldLines).toBe(1);
    expect(hunks[0].newLines).toBe(1);
  });

  test("\\ No newline at end of file は読み飛ばす", () => {
    const hunks = parseUnifiedDiffHunks("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(hunks[0].lines).toEqual([
      { kind: "removed", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });
});

describe("expandDiffLines", () => {
  test("1-based の指定行範囲を old / new ペアで返す", () => {
    const result = expandDiffLines("a\nb\nc\n", "a\nB\nc\n", 2, 2, 2);
    expect(result).toEqual([
      { oldLineNo: 2, newLineNo: 2, oldText: "b", newText: "B" },
      { oldLineNo: 3, newLineNo: 3, oldText: "c", newText: "c" },
    ]);
  });

  test("lines=0 は空配列", () => {
    expect(expandDiffLines("a\n", "a\n", 1, 1, 0)).toEqual([]);
  });

  test("範囲外は silent に空を返さず throw する", () => {
    expect(() => expandDiffLines("a\n", "a\n", 1, 1, 5)).toThrow(/out of range/);
  });
});

describe("diffHunks (integration)", () => {
  test("実 git diff --no-index で hunk と総行数を返す", async () => {
    const result = await diffHunks("line1\nline2\nline3\n", "line1\nchanged\nline3\n");
    expect(result.oldTotalLines).toBe(3);
    expect(result.newTotalLines).toBe(3);
    expect(result.hunks).toHaveLength(1);
    const kinds = result.hunks[0].lines.map((line) => line.kind);
    expect(kinds).toContain("removed");
    expect(kinds).toContain("added");
  });

  test("差分なしは hunks 空で成功する（exit 0）", async () => {
    const result = await diffHunks("same\n", "same\n");
    expect(result.hunks).toEqual([]);
  });

  test("NUL byte 入り入力は binary 検知で throw する", async () => {
    expect(diffHunks("a\0b\n", "text\n")).rejects.toThrow(/binary/);
  });
});
