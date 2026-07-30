import { describe, expect, it } from "bun:test";
import { clampResizeDelta } from "./resizeDelta";

const SIZES = {
  startBeforeSize: 500,
  startAfterSize: 300,
  beforeMinSize: 200,
  afterMinSize: 100,
};

describe("clampResizeDelta", () => {
  it("両ペインの最小サイズに収まる delta はそのまま通す", () => {
    expect(clampResizeDelta(50, SIZES)).toBe(50);
    expect(clampResizeDelta(-50, SIZES)).toBe(-50);
  });

  it("after を最小サイズまで縮める量で正方向を止める", () => {
    expect(clampResizeDelta(1000, SIZES)).toBe(200);
  });

  it("before を最小サイズまで縮める量で負方向を止める", () => {
    expect(clampResizeDelta(-1000, SIZES)).toBe(-300);
  });

  it("before が最小を割っている状態では 0 を返す", () => {
    expect(clampResizeDelta(1, { ...SIZES, startBeforeSize: 100 })).toBe(0);
    expect(clampResizeDelta(-1, { ...SIZES, startBeforeSize: 100 })).toBe(0);
  });

  it("after が最小を割っている状態では 0 を返す", () => {
    expect(clampResizeDelta(1, { ...SIZES, startAfterSize: 50 })).toBe(0);
    expect(clampResizeDelta(-1, { ...SIZES, startAfterSize: 50 })).toBe(0);
  });

  it("開始サイズが取れない（0）ときは drag を no-op にする", () => {
    expect(clampResizeDelta(100, { ...SIZES, startBeforeSize: 0, startAfterSize: 0 })).toBe(0);
  });
});
