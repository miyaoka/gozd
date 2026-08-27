import type { DiffExpandedLine, DiffHunk } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import {
  type DiffBarItem,
  type DiffSplitRowItem,
  type DiffViewItem,
  type IntraLineRangeMaps,
  barKey,
  barLabel,
  buildBaseItems,
  buildSplitRenderRows,
  buildUnifiedRenderRows,
  lineNoWidth,
  splitIntoSections,
} from "./diffViewModel";
import type { ThemedToken } from "./useHighlight";

/**
 * 検証はモジュールの公開 API (`buildBaseItems` / `buildUnifiedRenderRows` /
 * `buildSplitRenderRows` / `splitIntoSections`) からのみ行う。内部の分解 (hunk の走査、
 * unified / split への展開、1 行分の組み立て) をテストのために export すると、モジュールの
 * 公開 API がテストの都合で決まり、内部の作り替えがテストを壊すようになる。
 */

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

/** 行内 range を持たない空マップ。token の埋め込みだけを見るときに使う */
function noRanges(): IntraLineRangeMaps {
  return { old: new Map(), new: new Map() };
}

/** 行 1 つ分のトークン列。content だけ識別できればよいので他の属性は持たせない */
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

  test("context は両側の行番号を持ち、変更行は片側だけを持つ", () => {
    // 先行 hunk で new 側だけ 1 行増やし、以降の old / new の行番号をずらす。
    // 単一 hunk で開始行をずらすと先頭 gap が食い違い、unified diff として成立しない
    const { items } = buildBaseItems(
      [
        hunk(1, 1, 1, 2, [ctx("head"), add("inserted")]),
        hunk(3, 2, 4, 2, [ctx("c"), del("a"), add("A")]),
      ],
      4,
      5,
    );

    // unified では変更行を対応する側でしか表示しないため、反対側の行番号は持たない。
    // run は git の unified diff と同じく removed → added の順
    expect(items).toEqual([
      { type: "line", kind: "unchanged", text: "head", oldLineNo: 1, newLineNo: 1 },
      { type: "line", kind: "added", text: "inserted", newLineNo: 2 },
      { type: "hunk-bar", oldStart: 2, newStart: 3, lines: 1 },
      { type: "line", kind: "unchanged", text: "c", oldLineNo: 3, newLineNo: 4 },
      { type: "line", kind: "removed", text: "a", oldLineNo: 4 },
      { type: "line", kind: "added", text: "A", newLineNo: 5 },
    ]);
  });

  test("run の中でも行番号は 1 行ずつ進む", () => {
    const { items } = buildBaseItems(
      [hunk(1, 2, 1, 2, [del("x"), del("y"), add("X"), add("Y")])],
      2,
      2,
    );

    expect(items).toEqual([
      { type: "line", kind: "removed", text: "x", oldLineNo: 1 },
      { type: "line", kind: "removed", text: "y", oldLineNo: 2 },
      { type: "line", kind: "added", text: "X", newLineNo: 1 },
      { type: "line", kind: "added", text: "Y", newLineNo: 2 },
    ]);
  });

  test("split は removed run と added run を左右にペアリングする", () => {
    const { splitItems } = buildBaseItems([hunk(1, 1, 1, 1, [del("a"), add("A")])], 1, 1);

    expect(splitItems).toEqual([
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

  test("split で run 長が不揃いなら余りは片側だけの row になる", () => {
    const { splitItems } = buildBaseItems([hunk(1, 1, 1, 2, [del("a"), add("A"), add("B")])], 1, 2);

    expect(splitItems.at(-1)).toEqual({
      type: "split-row",
      kind: "modified",
      oldLineNo: undefined,
      oldText: undefined,
      newLineNo: 2,
      newText: "B",
    });
  });

  test("変更ブロックの行内 range を絶対行番号を key にして積む", () => {
    // 行内 diff の中身は intraLineDiff 側の担当。ここが守るのは
    // 「呼ばれていること」と「key が run 内 index ではなく絶対行番号であること」
    const { ranges } = buildBaseItems(
      [hunk(10, 1, 10, 1, [del("const foo = 1;"), add("const bar = 1;")])],
      10,
      10,
    );

    expect(ranges.old.get(10)).toEqual([{ start: 7, end: 10 }]);
    expect(ranges.new.get(10)).toEqual([{ start: 7, end: 10 }]);
    // run 内 index を key にする退行を弾く (この hunk の run は 0 番目から始まる)
    expect(ranges.old.has(0)).toBe(false);
  });

  test("片側しか無い run には行内 range を積まない", () => {
    // 対応する相手がいないので文字単位の比較対象が無い
    const { ranges } = buildBaseItems([hunk(0, 0, 1, 2, [add("a"), add("b")])], 0, 2);

    expect(ranges.old.size).toBe(0);
    expect(ranges.new.size).toBe(0);
  });
});

const ORIG_TOKENS = [[token("old-1")], [token("old-2")]];
const CURR_TOKENS = [[token("new-1")], [token("new-2")]];

const BAR: DiffBarItem = { type: "hunk-bar", oldStart: 1, newStart: 1, lines: 2 };

const EXPANDED: DiffExpandedLine[] = [
  { oldLineNo: 1, newLineNo: 1, oldText: "a", newText: "a" },
  { oldLineNo: 2, newLineNo: 2, oldText: "b", newText: "b" },
];

describe("buildUnifiedRenderRows", () => {
  const removedLine: DiffViewItem = { type: "line", kind: "removed", text: "x", oldLineNo: 2 };
  const addedLine: DiffViewItem = { type: "line", kind: "added", text: "x", newLineNo: 1 };

  test("removed 行は 1-based の行番号で original 側トークンを引く", () => {
    const [row] = buildUnifiedRenderRows(
      [removedLine],
      ORIG_TOKENS,
      CURR_TOKENS,
      noRanges(),
      new Map(),
    );

    expect(row).toMatchObject({ tokens: [token("old-2")] });
  });

  test("added 行は 1-based の行番号で current 側トークンを引く", () => {
    const [row] = buildUnifiedRenderRows(
      [addedLine],
      ORIG_TOKENS,
      CURR_TOKENS,
      noRanges(),
      new Map(),
    );

    expect(row).toMatchObject({ tokens: [token("new-1")] });
  });

  test("片側のトークンしか揃っていなければ埋めない", () => {
    const [row] = buildUnifiedRenderRows(
      [addedLine],
      ORIG_TOKENS,
      undefined,
      noRanges(),
      new Map(),
    );

    expect(row).toMatchObject({ tokens: undefined });
  });

  test("行内 range は kind に対応する側のマップから引く", () => {
    const ranges: IntraLineRangeMaps = {
      old: new Map([[2, [{ start: 1, end: 3 }]]]),
      new: new Map(),
    };
    const [row] = buildUnifiedRenderRows(
      [removedLine],
      ORIG_TOKENS,
      CURR_TOKENS,
      ranges,
      new Map(),
    );

    expect(row).toMatchObject({ innerRanges: [{ start: 1, end: 3 }] });
  });

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
  const contextRow: DiffSplitRowItem = {
    type: "split-row",
    kind: "context",
    oldLineNo: 1,
    oldText: "a",
    newLineNo: 1,
    newText: "a",
  };
  const modifiedRow: DiffSplitRowItem = {
    type: "split-row",
    kind: "modified",
    oldLineNo: 1,
    oldText: "ab",
    newLineNo: 1,
    newText: "abc",
  };
  const ranges: IntraLineRangeMaps = {
    old: new Map([[1, [{ start: 0, end: 2 }]]]),
    new: new Map([[1, [{ start: 0, end: 3 }]]]),
  };

  test("context 行には行内 range を付けない", () => {
    // 行内 range は modified 行にしか積まれない。context の行番号で引くと別の行の range を拾う
    const [row] = buildSplitRenderRows([contextRow], undefined, undefined, ranges, new Map());

    expect(row).toMatchObject({ oldInnerRanges: undefined, newInnerRanges: undefined });
  });

  test("modified 行には両側の行内 range が付く", () => {
    const [row] = buildSplitRenderRows([modifiedRow], undefined, undefined, ranges, new Map());

    expect(row).toMatchObject({
      oldInnerRanges: [{ start: 0, end: 2 }],
      newInnerRanges: [{ start: 0, end: 3 }],
    });
  });

  test("両側のトークンをそれぞれの行番号で引く", () => {
    const [row] = buildSplitRenderRows(
      [{ ...modifiedRow, oldLineNo: 2, newLineNo: 1 }],
      ORIG_TOKENS,
      CURR_TOKENS,
      noRanges(),
      new Map(),
    );

    expect(row).toMatchObject({ oldTokens: [token("old-2")], newTokens: [token("new-1")] });
  });

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
