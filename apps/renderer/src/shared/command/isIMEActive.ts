/**
 * IME 変換中かどうかを判定する。
 * isComposing が false のまま keyCode 229 で届く keydown があるため、両方をチェックする。
 *
 * EditContext を付けた要素では、変換中の keydown が isComposing を持たないことがある。
 * そうした要素は変換中に `IME_COMPOSING_ATTRIBUTE` を付け、ここはそれも見る。
 * 観測したのは CDP から送った ⌘ の keydown だけ。実キーボードのキーでも EditContext の変換中に
 * isComposing が付くと確かめられたら、属性をやめて isComposing だけに戻せる。
 */
const IME_KEYCODE = 229;

export const IME_COMPOSING_ATTRIBUTE = "data-ime-composing";

function isComposingTarget(target: EventTarget | null): boolean {
  if (target === null || !("hasAttribute" in target)) return false;
  return (target as Element).hasAttribute(IME_COMPOSING_ATTRIBUTE);
}

export function isIMEActive(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === IME_KEYCODE || isComposingTarget(e.target);
}
