// OS へ渡してよい URL の唯一の判定点。untrusted 入力（terminal の OSC 8、markdown の href、
// previewed HTML のリンク）が直接届くため、既知のバイパス文字列を回帰テストで固定する。
// renderer の openExternal と main の navigation 防壁が共にこの述語を使う。
import { describe, expect, test } from "bun:test";
import { isExternalUrl } from "./externalUrl";

describe("isExternalUrl", () => {
  test("http / https / mailto は許可", () => {
    expect(isExternalUrl("http://example.com/")).toBe(true);
    expect(isExternalUrl("https://example.com/")).toBe(true);
    expect(isExternalUrl("mailto:user@example.com")).toBe(true);
  });

  test("scheme の大文字は URL が正規化するので許可", () => {
    expect(isExternalUrl("HTTPS://example.com/")).toBe(true);
  });

  test("ローカルファイル / 実行可能 scheme は拒否", () => {
    expect(isExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isExternalUrl("blob:https://example.com/abcd")).toBe(false);
  });

  test("OS ハンドラに渡り得る他 scheme も拒否 (allowlist なので既定で落ちる)", () => {
    expect(isExternalUrl("ftp://example.com/")).toBe(false);
    expect(isExternalUrl("tel:+81000000000")).toBe(false);
    expect(isExternalUrl("sms:+81000000000")).toBe(false);
    expect(isExternalUrl("vscode://file/etc/passwd")).toBe(false);
  });

  test("制御文字を混ぜた偽装は拒否", () => {
    expect(isExternalUrl("java\nscript:alert(1)")).toBe(false);
    expect(isExternalUrl(" javascript:alert(1)")).toBe(false);
  });

  test("URL として解釈できない文字列は拒否", () => {
    expect(isExternalUrl("")).toBe(false);
    expect(isExternalUrl("not a url")).toBe(false);
    expect(isExternalUrl("//example.com/")).toBe(false);
  });
});
