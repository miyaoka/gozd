import { describe, expect, test } from "bun:test";
import { toWireBytes } from "./wireBytes";

describe("toWireBytes", () => {
  test("共有プール view から専有 buffer へ exact-size コピーされる", () => {
    // readFileSync の小ファイル読みを模した「大きなプールの一部を view する Buffer」。
    // プール直返しに退行すると byteOffset / buffer.byteLength の検証が fail する
    const pool = new ArrayBuffer(8192);
    const view = Buffer.from(pool, 100, 5);
    view.set([1, 2, 3, 4, 5]);

    const wire = toWireBytes(view);

    expect(Array.from(wire)).toEqual([1, 2, 3, 4, 5]);
    // 専有 buffer: view の切り出しではなく、backing ArrayBuffer が中身ちょうどのサイズ
    expect(wire.byteOffset).toBe(0);
    expect(wire.buffer.byteLength).toBe(wire.byteLength);
    expect(wire.buffer).not.toBe(pool);
  });

  test("コピー後の元 Buffer 変更は伝播しない（プールから切り離されている）", () => {
    const source = Buffer.from([9, 8, 7]);
    const wire = toWireBytes(source);
    source[0] = 0;
    expect(wire[0]).toBe(9);
  });
});
