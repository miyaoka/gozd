import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { describe, expect, test } from "bun:test";
import { collectIndentedBlock } from "./collectIndentedBlock";

/** collectIndentedBlock が使う getLine だけを持つ最小バッファモック */
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

describe("collectIndentedBlock", () => {
  test("ハードラップ（isWrapped）は空白なしで連結する", () => {
    const buf = mockBuffer([
      { text: "/Users/me/proj/src/very/lo" },
      { text: "ng/file.ts", wrapped: true },
    ]);
    // 継続行(idx 1)にホバー
    const [joined, offset] = collectIndentedBlock(buf, 1);
    expect(joined).toBe("/Users/me/proj/src/very/long/file.ts");
    expect(offset).toBe("/Users/me/proj/src/very/lo".length);
  });

  test("明示改行+インデントのセグメント途中折り返しを連結する（リグレッション）", () => {
    const buf = mockBuffer([
      { text: "/Users/me/proj/src/very/lo" },
      { text: "  ng/file.ts" }, // 非 wrapped・インデント・パス文字始まり
    ]);
    const [joined, offset] = collectIndentedBlock(buf, 1);
    expect(joined).toBe("/Users/me/proj/src/very/long/file.ts");
    expect(offset).toBe("/Users/me/proj/src/very/lo".length);
  });

  test("区切り文字始まりのインデント行（shell コメント）は連結しない", () => {
    const buf = mockBuffer([
      { text: "/Users/me/elsewhere/b8i8z99z7.txt" },
      { text: "  # 52行目以降から is_error を抽出" }, // `#` 始まり = 別トークン
    ]);
    // パス行(idx 0)にホバー
    const [joined, offset] = collectIndentedBlock(buf, 0);
    expect(joined).toBe("/Users/me/elsewhere/b8i8z99z7.txt");
    expect(offset).toBe(0);
  });

  test("インデントの無い次行は連結しない", () => {
    const buf = mockBuffer([{ text: "/Users/me/a.txt" }, { text: "next line" }]);
    const [joined] = collectIndentedBlock(buf, 0);
    expect(joined).toBe("/Users/me/a.txt");
  });

  test("非パス行の下のインデント絶対パスは継続扱いせず汚染しない", () => {
    const buf = mockBuffer([
      { text: "#!/usr/bin/env bash and more" }, // 非インデント・非パス行
      { text: "  /Users/me/proj/src/x.ts" }, // インデント・単独絶対パス（ここにホバー）
    ]);
    const [joined, offset] = collectIndentedBlock(buf, 1);
    // 上の非パス行を連結せず、現在行のみを返す（先頭インデントは保持）
    expect(joined).toBe("  /Users/me/proj/src/x.ts");
    expect(offset).toBe(0);
  });

  test("インデント絶対パス(`~/`)も上の非パス行と連結しない", () => {
    const buf = mockBuffer([{ text: "echo done" }, { text: "  ~/proj/src/x.ts" }]);
    const [joined] = collectIndentedBlock(buf, 1);
    expect(joined).toBe("  ~/proj/src/x.ts");
  });
});
