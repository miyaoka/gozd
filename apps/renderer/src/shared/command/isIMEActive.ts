/**
 * IME 変換中かどうかを判定する。
 * WKWebView では isComposing が false のまま keyCode 229 が送られるケースがあるため、
 * 両方をチェックする。
 */
const IME_KEYCODE = 229;

export function isIMEActive(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === IME_KEYCODE;
}
