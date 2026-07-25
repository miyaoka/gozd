// toChildWindowInit (昇格位置の換算) の境界テスト。対象は「コンテンツ原点は chrome 高で
// 補正される」「サイズはそのまま通る」「chrome 0 / 負のスクリーン原点でも式が破れない」の 3 点。
import { describe, expect, test } from "bun:test";
import { toChildWindowInit } from "./childWindowInit";

const RECT = { left: 100, top: 50, width: 400, height: 300 };

describe("toChildWindowInit", () => {
  test("スクリーン原点 + chrome 高で viewport rect を換算する", () => {
    expect(toChildWindowInit(RECT, { screenX: 20, screenY: 10, chromeY: 36 })).toEqual({
      screenX: 120,
      screenY: 96,
      width: 400,
      height: 300,
    });
  });

  test("chrome 高 0 (frameless) では y 補正が入らない", () => {
    const init = toChildWindowInit(RECT, { screenX: 0, screenY: 0, chromeY: 0 });
    expect(init.screenX).toBe(RECT.left);
    expect(init.screenY).toBe(RECT.top);
  });

  test("負のスクリーン原点 (左側のサブディスプレイ) でも符号を保つ", () => {
    const init = toChildWindowInit(RECT, { screenX: -1920, screenY: -200, chromeY: 36 });
    expect(init.screenX).toBe(-1820);
    expect(init.screenY).toBe(-114);
  });
});
