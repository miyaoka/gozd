// リンク起動の境界。ここを落とすと「リンクが無音で死ぬ」形で退行し、UI 上は何も起きないため
// 気づけない。中クリック (button 1) と control+click の扱いを回帰テストで固定する。
import { describe, expect, test } from "bun:test";
import { isLinkActivation } from "./openExternal";

/** MouseEvent のうち判定が読むフィールドだけを持つ最小の入力 */
function mouseEvent(init: { button: number; ctrlKey?: boolean }): MouseEvent {
  return { button: init.button, ctrlKey: init.ctrlKey ?? false } as MouseEvent;
}

describe("isLinkActivation", () => {
  test("左クリックはリンク起動", () => {
    expect(isLinkActivation(mouseEvent({ button: 0 }))).toBe(true);
  });

  test("中クリックもリンク起動", () => {
    expect(isLinkActivation(mouseEvent({ button: 1 }))).toBe(true);
  });

  test("右クリックはリンク起動ではない", () => {
    expect(isLinkActivation(mouseEvent({ button: 2 }))).toBe(false);
  });

  test("control+左クリックはコンテキストメニュー意図なのでリンク起動ではない", () => {
    expect(isLinkActivation(mouseEvent({ button: 0, ctrlKey: true }))).toBe(false);
  });
});
