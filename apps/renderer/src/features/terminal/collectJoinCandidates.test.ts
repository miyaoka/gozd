import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { describe, expect, test } from "bun:test";
import { collectJoinCandidates } from "./collectJoinCandidates";

/** collectJoinCandidates が使う getLine だけを持つ最小バッファモック */
function mockBuffer(lines: Array<{ text: string; wrapped?: boolean }>): IBuffer {
  const getLine = (y: number): IBufferLine | undefined => {
    const entry = lines[y];
    if (!entry) return undefined;
    return {
      isWrapped: entry.wrapped ?? false,
      translateToString: () => entry.text,
    } as unknown as IBufferLine;
  };
  return { getLine } as unknown as IBuffer;
}

/** 結合テキストだけを取り出す */
const texts = (buf: IBuffer, lineIdx: number): string[] =>
  collectJoinCandidates(buf, lineIdx).map((j) => j.text);

describe("collectJoinCandidates", () => {
  test("結合しない範囲（現在行のみ）を必ず含む", () => {
    const buf = mockBuffer([{ text: "/Users/me/a.txt" }, { text: "next line" }]);
    expect(texts(buf, 0)).toContain("/Users/me/a.txt");
  });

  test("ハードラップ（isWrapped）は空白なしで連結する", () => {
    const buf = mockBuffer([
      { text: "/Users/me/proj/src/very/lo" },
      { text: "ng/file.ts", wrapped: true },
    ]);
    expect(texts(buf, 1)).toContain("/Users/me/proj/src/very/long/file.ts");
  });

  test("明示改行+インデントのセグメント途中折り返しを連結する", () => {
    const buf = mockBuffer([{ text: "/Users/me/proj/src/very/lo" }, { text: "  ng/file.ts" }]);
    expect(texts(buf, 1)).toContain("/Users/me/proj/src/very/long/file.ts");
  });

  test("折り返しが `/` の直前に来ても連結する", () => {
    const head = "/private/tmp/claude-501/-Users-me-worktrees-front-20260820-210347";
    const buf = mockBuffer([{ text: head }, { text: "/334a62aa/scratchpad/rfc3986.txt" }]);
    expect(texts(buf, 1)).toContain(`${head}/334a62aa/scratchpad/rfc3986.txt`);
  });

  test("隣接する別々のパスでも、結合しない範囲が候補に残る", () => {
    // パス文字が続くので連結もされるが、正しい範囲（各行単独）が漏れてはいけない
    const buf = mockBuffer([{ text: "/tmp/a.txt" }, { text: "/tmp/b.txt" }]);
    const joined = texts(buf, 1);
    expect(joined).toContain("/tmp/b.txt");
    expect(joined).toContain("/tmp/a.txt/tmp/b.txt");
  });

  test("3 行にまたがる折り返しは、中間の範囲も候補に含む", () => {
    const buf = mockBuffer([{ text: "/tmp/zzz" }, { text: "/aaa/bbb" }, { text: "/ccc.txt" }]);
    const joined = texts(buf, 1);
    expect(joined).toContain("/aaa/bbb"); // 現在行のみ
    expect(joined).toContain("/aaa/bbb/ccc.txt"); // 下だけ結合
    expect(joined).toContain("/tmp/zzz/aaa/bbb"); // 上だけ結合
    expect(joined).toContain("/tmp/zzz/aaa/bbb/ccc.txt"); // 全部結合
  });

  test("行末が区切り文字なら連結しない", () => {
    const buf = mockBuffer([
      { text: "some output ending with a paren)" },
      { text: "/Users/me/b.txt" },
    ]);
    expect(texts(buf, 1)).toEqual(["/Users/me/b.txt"]);
  });

  test("区切り文字始まりの次行は連結しない", () => {
    const buf = mockBuffer([{ text: "/Users/me/a.txt" }, { text: "# comment" }]);
    expect(texts(buf, 0)).toEqual(["/Users/me/a.txt"]);
  });

  test("現在行のオフセットは結合範囲ごとに正しい", () => {
    const head = "/tmp/head";
    const buf = mockBuffer([{ text: head }, { text: "/tail.txt" }]);
    for (const c of collectJoinCandidates(buf, 1)) {
      expect(c.text.slice(c.currentLineOffset)).toBe("/tail.txt");
    }
  });

  test("インデント継続でも、落とした幅を戻せば raw 行と一致する", () => {
    const current = "  ng/file.ts";
    const buf = mockBuffer([{ text: "/Users/me/proj/src/very/lo" }, { text: current }]);
    for (const c of collectJoinCandidates(buf, 1)) {
      expect(c.text.slice(c.currentLineOffset)).toBe(current.slice(c.currentLineTrimmed));
    }
  });

  test("落としたインデント幅を報告する（リンク範囲を raw 行へ戻すため）", () => {
    const buf = mockBuffer([{ text: "/Users/me/proj/src/very/lo" }, { text: "  ng/file.ts" }]);
    const joined = collectJoinCandidates(buf, 1);
    // 現在行のみの範囲は trim されない。上と結合した範囲だけインデントが落ちる
    expect(joined.map((c) => c.currentLineTrimmed).sort((a, b) => a - b)).toEqual([0, 2]);
  });
});
