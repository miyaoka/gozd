// deriveResize (反対辺アンカー算術) の境界テスト。対象は「min/max に当たってもアンカー辺が
// 滑らない」「上辺が topMin (タイトルバー直下) で止まる」「角が width/height と x/y を揃えて
// 返す」の 3 不変条件。
import { describe, expect, test } from "bun:test";
import { deriveResize, type ResizeBounds, type ResizeStartRect } from "./pinnedLogResize";

// left=100, top=100 の 400x300 ウィンドウ (right=500, bottom=400)
const START_RECT: ResizeStartRect = { width: 400, height: 300, right: 500, bottom: 400 };

const BOUNDS: ResizeBounds = {
  minWidth: 256,
  maxWidth: 1000,
  minHeight: 64,
  maxHeight: 800,
  topMin: 36,
};

describe("右/下辺 (アンカー不要)", () => {
  test("e は width だけ、s は height だけを delta に追従して返す", () => {
    expect(deriveResize("e", 50, 999, START_RECT, BOUNDS)).toEqual({ width: 450 });
    expect(deriveResize("s", 999, -100, START_RECT, BOUNDS)).toEqual({ height: 200 });
  });

  test("e は min/max でクランプされる", () => {
    expect(deriveResize("e", -9999, 0, START_RECT, BOUNDS)).toEqual({ width: 256 });
    expect(deriveResize("e", 9999, 0, START_RECT, BOUNDS)).toEqual({ width: 1000 });
  });
});

describe("左辺 (右辺アンカー)", () => {
  test("width と x が同時に動き、右辺 (x + width) が固定される", () => {
    const result = deriveResize("w", -60, 0, START_RECT, BOUNDS);
    expect(result).toEqual({ width: 460, x: 40 });
    expect((result.x ?? 0) + (result.width ?? 0)).toBe(START_RECT.right);
  });

  test("min に当たっても右辺が滑らない (サイズ先クランプ → 位置逆算)", () => {
    // pointer を右へ大きく動かして min 幅を割り込ませる
    const result = deriveResize("w", 9999, 0, START_RECT, BOUNDS);
    expect(result).toEqual({ width: 256, x: 500 - 256 });
  });

  test("max に当たっても右辺が滑らない", () => {
    const result = deriveResize("w", -9999, 0, START_RECT, BOUNDS);
    expect(result).toEqual({ width: 1000, x: 500 - 1000 });
  });
});

describe("上辺 (下辺アンカー)", () => {
  test("height と y が同時に動き、下辺 (y + height) が固定される", () => {
    const result = deriveResize("n", 0, -50, START_RECT, BOUNDS);
    expect(result).toEqual({ height: 350, y: 50 });
    expect((result.y ?? 0) + (result.height ?? 0)).toBe(START_RECT.bottom);
  });

  test("min に当たっても下辺が滑らない", () => {
    const result = deriveResize("n", 0, 9999, START_RECT, BOUNDS);
    expect(result).toEqual({ height: 64, y: 400 - 64 });
  });

  test("上端は topMin で止まる (高さ上限 = bottom - topMin)", () => {
    const result = deriveResize("n", 0, -9999, START_RECT, BOUNDS);
    expect(result).toEqual({ height: 400 - 36, y: 36 });
  });

  test("maxHeight が bottom - topMin より小さければ maxHeight が勝つ", () => {
    const result = deriveResize("n", 0, -9999, START_RECT, { ...BOUNDS, maxHeight: 320 });
    expect(result).toEqual({ height: 320, y: 400 - 320 });
  });
});

describe("角 (2 軸合成)", () => {
  test("se は width / height のみ (位置は動かない)", () => {
    expect(deriveResize("se", 30, 40, START_RECT, BOUNDS)).toEqual({ width: 430, height: 340 });
  });

  test("nw は 4 値が揃い、右辺と下辺の両方が固定される", () => {
    const result = deriveResize("nw", -20, -30, START_RECT, BOUNDS);
    expect(result).toEqual({ width: 420, x: 80, height: 330, y: 70 });
    expect((result.x ?? 0) + (result.width ?? 0)).toBe(START_RECT.right);
    expect((result.y ?? 0) + (result.height ?? 0)).toBe(START_RECT.bottom);
  });

  test("nw で両軸とも min に当たってもアンカー 2 辺が滑らない", () => {
    const result = deriveResize("nw", 9999, 9999, START_RECT, BOUNDS);
    expect(result).toEqual({ width: 256, x: 500 - 256, height: 64, y: 400 - 64 });
  });
});
