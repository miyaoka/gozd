/**
 * IME 変換中かどうかを判定する。
 * isComposing が false のまま keyCode 229 で届く keydown があるため、両方をチェックする。
 */
const IME_KEYCODE = 229;

export function isIMEActive(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === IME_KEYCODE;
}
