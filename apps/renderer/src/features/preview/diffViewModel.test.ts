import type { DiffExpandedLine, DiffHunk } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import {
  type DiffBarItem,
  type DiffSplitViewItem,
  type DiffViewItem,
  type IntraLineRangeMaps,
  barKey,
  barLabel,
  buildBaseItems,
  buildRenderedLine,
  buildRenderedSplitRow,
  buildSplitRenderRows,
  buildUnifiedRenderRows,
  collectHunkSegments,
  expandHunkLinesSplit,
  expandHunkLinesUnified,
  lineNoWidth,
  splitIntoSections,
} from "./diffViewModel";
import type { ThemedToken } from "./useHighlight";

const ctx = (text: string) => ({ kind: "context" as const, text });
const del = (text: string) => ({ kind: "removed" as const, text });
const add = (text: string) => ({ kind: "added" as const, text });

function hunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: DiffHunk["lines"],
): DiffHunk {
  return { oldStart, oldLines, newStart, newLines, lines };
}

/** 行内 range を持たない空マップ。token 埋め込みだけを見るテストで使う */
function noRanges(): IntraLineRangeMaps {
  return { old: new Map(), new: new Map() };
}

/** 行 1 つ分のトークン列。content だけが識別できればよいので他の属性は持たせない */
function token(content: string): ThemedToken {
  return { content, offset: 0 };
}

describe("buildBaseItems", () => {
  test("ファイル先頭の unchanged 範囲が hunk-bar になる", () => {
    // 1-2 行目が hunk の外にある = 省略された unchanged 範囲
    const [first] = buildBaseItems([hunk(3, 1, 3, 1, [ctx("c")])], 3, 3).items;

    expect(first).toEqual({ type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 });
  });

  test("ファイル末尾の unchanged 範囲が hunk-bar になる", () => {
    const { items } = buildBaseItems([hunk(1, 1, 1, 1, [ctx("c")])], 4, 4);

    expect(items.at(-1)).toEqual({ type: "hunk-bar", oldStart: 2, newStart: 2, lines: 3 });
  });

  test("hunk-bar は unified と split の両方に同じ内容で入る", () => {
    const { items, splitItems } = buildBaseItems([hunk(3, 1, 3, 1, [ctx("c")])], 3, 3);
    const bar: DiffBarItem = { type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 };

    // 展開キャッシュの key は barKey なので、両モードで同じ bar を指す必要がある
    expect(items[0]).toEqual(bar);
    expect(splitItems[0]).toEqual(bar);
  });

  test("新規ファイル (old 側が 0 行) を invariant 違反にしない", () => {
    // `@@ -0,0 +1,2 @@`。old 側は start / lines ともに 0 で、gap も末尾も存在しない
    const { items } = buildBaseItems([hunk(0, 0, 1, 2, [add("a"), add("b")])], 0, 2);

    expect(items).toEqual([
      { type: "line", kind: "added", text: "a", newLineNo: 1 },
      { type: "line", kind: "added", text: "b", newLineNo: 2 },
    ]);
  });

  test("削除ファイル (new 側が 0 行) を invariant 違反にしない", () => {
    // `@@ -1,2 +0,0 @@`
    const { items } = buildBaseItems([hunk(1, 2, 0, 0, [del("a"), del("b")])], 2, 0);

    expect(items).toEqual([
      { type: "line", kind: "removed", text: "a", oldLineNo: 1 },
      { type: "line", kind: "removed", text: "b", oldLineNo: 2 },
    ]);
  });

  test("hunk 間の gap が old / new で食い違う入力は throw する", () => {
    // 1 つ目の hunk の後、old 側は 3 行 / new 側は 1 行あいている = unified diff として成立しない
    const hunks = [hunk(1, 1, 1, 1, [ctx("a")]), hunk(5, 1, 3, 1, [ctx("b")])];

    expect(() => buildBaseItems(hunks, 5, 3)).toThrow(/invariant violation at hunk #1/);
  });

  test("末尾の残り行数が old / new で食い違う入力は throw する", () => {
    expect(() => buildBaseItems([hunk(1, 1, 1, 1, [ctx("a")])], 3, 5)).toThrow(
      /trailing invariant violation/,
    );
  });
});

describe("collectHunkSegments", () => {
  test("context 行は old / new 両方の行番号を進める", () => {
    const segments = collectHunkSegments(hunk(10, 2, 20, 2, [ctx("a"), ctx("b")]));

    expect(segments).toEqual([
      { kind: "context", oldLineNo: 10, newLineNo: 20, text: "a" },
      { kind: "context", oldLineNo: 11, newLineNo: 21, text: "b" },
    ]);
  });

  test("連続する removed と added を 1 つの run にまとめる", () => {
    const segments = collectHunkSegments(
      hunk(1, 2, 1, 2, [del("x"), del("y"), add("X"), add("Y")]),
    );

    expect(segments).toEqual([
      {
        kind: "run",
        removeds: [
          { lineNo: 1, text: "x" },
          { lineNo: 2, text: "y" },
        ],
        addeds: [
          { lineNo: 1, text: "X" },
          { lineNo: 2, text: "Y" },
        ],
      },
    ]);
  });

  test("added だけの run は removeds が空になる", () => {
    const [segment] = collectHunkSegments(hunk(5, 0, 5, 1, [add("new")]));

    expect(segment).toEqual({ kind: "run", removeds: [], addeds: [{ lineNo: 5, text: "new" }] });
  });
});

describe("expandHunkLinesUnified", () => {
  test("context は両側の行番号を持ち、run は removed を先に added を後に並べる", () => {
    const items: DiffViewItem[] = [];
    expandHunkLinesUnified(
      collectHunkSegments(hunk(10, 2, 20, 2, [ctx("c"), del("a"), add("A")])),
      items,
    );

    // 変更行は片側の行番号しか持たない (unified では対応する側だけを表示する)
    expect(items).toEqual([
      { type: "line", kind: "unchanged", text: "c", oldLineNo: 10, newLineNo: 20 },
      { type: "line", kind: "removed", text: "a", oldLineNo: 11 },
      { type: "line", kind: "added", text: "A", newLineNo: 21 },
    ]);
  });
});

describe("expandHunkLinesSplit", () => {
  test("removed run と added run を左右にペアリングする", () => {
    const items: DiffSplitViewItem[] = [];
    expandHunkLinesSplit(collectHunkSegments(hunk(1, 1, 1, 1, [del("a"), add("A")])), items);

    expect(items).toEqual([
      {
        type: "split-row",
        kind: "modified",
        oldLineNo: 1,
        oldText: "a",
        newLineNo: 1,
        newText: "A",
      },
    ]);
  });

  test("run 長が不揃いなら余りは片側だけの row になる", () => {
    const items: DiffSplitViewItem[] = [];
    expandHunkLinesSplit(
      collectHunkSegments(hunk(1, 1, 1, 2, [del("a"), add("A"), add("B")])),
      items,
    );

    expect(items).toEqual([
      {
        type: "split-row",
        kind: "modified",
        oldLineNo: 1,
        oldText: "a",
        newLineNo: 1,
        newText: "A",
      },
      {
        type: "split-row",
        kind: "modified",
        oldLineNo: undefined,
        oldText: undefined,
        newLineNo: 2,
        newText: "B",
      },
    ]);
  });
});

describe("buildRenderedLine", () => {
  const orig = [token("old-1"), token("old-2")].map((t) => [t]);
  const curr = [token("new-1"), token("new-2")].map((t) => [t]);

  test("removed 行は 1-based の行番号で original 側トークンを引く", () => {
    const line = buildRenderedLine(
      { type: "line", kind: "removed", text: "x", oldLineNo: 2 },
      orig,
      curr,
      noRanges(),
    );

    expect(line.tokens).toEqual([token("old-2")]);
  });

  test("added 行は 1-based の行番号で current 側トークンを引く", () => {
    const line = buildRenderedLine(
      { type: "line", kind: "added", text: "x", newLineNo: 1 },
      orig,
      curr,
      noRanges(),
    );

    expect(line.tokens).toEqual([token("new-1")]);
  });

  test("片側のトークンしか揃っていなければ埋めない", () => {
    const line = buildRenderedLine(
      { type: "line", kind: "added", text: "x", newLineNo: 1 },
      orig,
      undefined,
      noRanges(),
    );

    expect(line.tokens).toBeUndefined();
  });

  test("行内 range は kind に対応する側のマップから引く", () => {
    const ranges: IntraLineRangeMaps = {
      old: new Map([[2, [{ start: 1, end: 3 }]]]),
      new: new Map(),
    };
    const line = buildRenderedLine(
      { type: "line", kind: "removed", text: "x", oldLineNo: 2 },
      orig,
      curr,
      ranges,
    );

    expect(line.innerRanges).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("buildRenderedSplitRow", () => {
  test("context 行には行内 range を付けない", () => {
    // 行内 range は modified 行にしか積まれない。context の行番号で引くと別の行の range を拾う
    const ranges: IntraLineRangeMaps = {
      old: new Map([[1, [{ start: 0, end: 2 }]]]),
      new: new Map([[1, [{ start: 0, end: 2 }]]]),
    };
    const row = buildRenderedSplitRow(
      {
        type: "split-row",
        kind: "context",
        oldLineNo: 1,
        oldText: "a",
        newLineNo: 1,
        newText: "a",
      },
      undefined,
      undefined,
      ranges,
    );

    expect(row.oldInnerRanges).toBeUndefined();
    expect(row.newInnerRanges).toBeUndefined();
  });

  test("modified 行には両側の行内 range が付く", () => {
    const ranges: IntraLineRangeMaps = {
      old: new Map([[1, [{ start: 0, end: 2 }]]]),
      new: new Map([[1, [{ start: 0, end: 3 }]]]),
    };
    const row = buildRenderedSplitRow(
      {
        type: "split-row",
        kind: "modified",
        oldLineNo: 1,
        oldText: "ab",
        newLineNo: 1,
        newText: "abc",
      },
      undefined,
      undefined,
      ranges,
    );

    expect(row.oldInnerRanges).toEqual([{ start: 0, end: 2 }]);
    expect(row.newInnerRanges).toEqual([{ start: 0, end: 3 }]);
  });
});

const BAR: DiffBarItem = { type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 };

const EXPANDED: DiffExpandedLine[] = [
  { oldLineNo: 1, newLineNo: 1, oldText: "a", newText: "a" },
  { oldLineNo: 2, newLineNo: 2, oldText: "b", newText: "b" },
];

describe("buildUnifiedRenderRows", () => {
  test("展開済みバーは unchanged 行に置き換わる", () => {
    const rows = buildUnifiedRenderRows(
      [BAR],
      undefined,
      undefined,
      noRanges(),
      new Map([[barKey(BAR), EXPANDED]]),
    );

    expect(rows.map((r) => (r.type === "line" ? r.text : r.type))).toEqual(["a", "b"]);
  });

  test("未展開のバーはバーのまま残る", () => {
    const rows = buildUnifiedRenderRows([BAR], undefined, undefined, noRanges(), new Map());

    expect(rows).toEqual([BAR]);
  });
});

describe("buildSplitRenderRows", () => {
  test("展開済みバーは両側にテキストを持つ context row に置き換わる", () => {
    const [first] = buildSplitRenderRows(
      [BAR],
      undefined,
      undefined,
      noRanges(),
      new Map([[barKey(BAR), EXPANDED]]),
    );

    expect(first).toMatchObject({ type: "split-row", kind: "context", oldText: "a", newText: "a" });
  });
});

describe("splitIntoSections", () => {
  const line = (text: string) => ({ type: "line" as const, kind: "unchanged" as const, text });

  test("hunk-bar を境界に section が切れる", () => {
    const sections = splitIntoSections([line("a"), BAR, line("b")]);

    expect(sections).toEqual([
      { type: "section", lines: [line("a")] },
      BAR,
      { type: "section", lines: [line("b")] },
    ]);
  });

  test("連続する hunk-bar の間に空 section を作らない", () => {
    const other: DiffBarItem = { type: "hunk-bar", oldStart: 9, newStart: 9, lines: 1 };
    const sections = splitIntoSections([BAR, other]);

    expect(sections).toEqual([BAR, other]);
  });

  test("末尾に残った行も section になる", () => {
    const sections = splitIntoSections([BAR, line("tail")]);

    expect(sections).toEqual([BAR, { type: "section", lines: [line("tail")] }]);
  });
});

describe("barKey", () => {
  test("oldStart / newStart / lines のすべてが key に効く", () => {
    // 1 つでも違えば別 key = 再 fetch で bar 構成が変わったときにキャッシュが当たらない
    const keys = new Set([
      barKey({ type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 }),
      barKey({ type: "hunk-bar", oldStart: 2, newStart: 1, lines: 2 }),
      barKey({ type: "hunk-bar", oldStart: 1, newStart: 2, lines: 2 }),
      barKey({ type: "hunk-bar", oldStart: 1, newStart: 1, lines: 3 }),
    ]);

    expect(keys.size).toBe(4);
  });
});

describe("barLabel", () => {
  test("1 行のときは単数形になる", () => {
    expect(barLabel({ type: "hunk-bar", oldStart: 1, newStart: 1, lines: 1 })).toBe(
      "1 unchanged line",
    );
  });

  test("複数行のときは複数形になる", () => {
    expect(barLabel({ type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 })).toBe(
      "2 unchanged lines",
    );
  });
});

describe("lineNoWidth", () => {
  test("桁数が多い側に合わせる", () => {
    expect(lineNoWidth(9, 100)).toBe("3ch");
  });

  test("両側が 0 行でも 1 桁分は確保する", () => {
    expect(lineNoWidth(0, 0)).toBe("1ch");
  });
});
