// リンク起動の境界。ここを落とすと「リンクが無音で死ぬ」形で退行し、UI 上は何も起きないため
// 気づけない。起動とみなすクリックの条件と、開けなかったときの通知の形を回帰テストで固定する。
import { describe, expect, test } from "bun:test";
import { isLinkActivation, openExternalOrNotify } from "./openExternal";

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

// 「message は固定・可変部は cause」はリンク起動層が共有する契約で、実装点はこの関数だけになった。
// 層ごとに書かれていた頃は片方だけ URL を message に埋める形で破れていたため、回帰テストで固定する。
describe("openExternalOrNotify", () => {
  test("allowlist 外の URL は開かず、固定 message と cause 付きで通知する", async () => {
    const calls: { message: string; cause?: unknown }[] = [];
    const url = "file:///etc/passwd";

    await openExternalOrNotify(url, (message, cause) => calls.push({ message, cause }));

    const [call] = calls;
    expect(calls).toHaveLength(1);
    expect(call?.message).toBe("Could not open link in the browser");
    // URL は message ではなく cause 側に載り、元エラーはさらにその cause から辿れる
    expect(call?.cause).toBeInstanceOf(Error);
    expect((call?.cause as Error).message).toContain(url);
    // 最内 cause で allowlist の門を通ったことを固定する。ここを見ないと、門を外して RPC へ
    // 抜けた場合でも (テスト環境に bridge が無く例外になるため) 同じ形の通知が届いて pass する
    const inner = (call?.cause as Error).cause;
    expect(inner).toBeInstanceOf(Error);
    expect((inner as Error).message).toContain("scheme not allowed");
  });
});
