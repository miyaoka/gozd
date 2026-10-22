/**
 * keydown を「IME（EditContext）だけに任せる」か「xterm に先に渡す」かを決める。
 *
 * 端末の文字入力は 2 つの経路を持つ。
 *
 * - xterm の keydown 処理。矢印・Ctrl・Enter・Backspace・Tab・Esc などの端末シーケンス化と、
 *   アプリケーションカーソルモードの扱いはすべてここに残す
 * - EditContext の textupdate / compositionend。xterm が引き受けなかった印字文字（CapsLock 中の
 *   大文字、Option の記号など）と、IME の確定文字はここから来る
 *
 * 1 回のキー入力はどちらか一方からだけ届く。xterm が引き受けたキーは既定動作を止めて
 * EditContext に文字を作らせず、引き受けなかったキーは既定動作のまま EditContext に任せる
 * （xtermInputPort.ts）。この関数が決めるのは、xterm に問い合わせてよいかだけ。
 *
 * xterm に問い合わせてはいけないキー:
 *
 * - 変換中のキー。変換中の Enter / Space / 矢印 / ⌘ は IME の操作で、端末への入力ではない。
 *   変換中かどうかは EditContext の compositionstart / compositionend から持つ状態で決める。
 *   keydown の `isComposing` に頼らない理由は shared/command の isIMEActive に書いた
 * - keyCode 229。IME がキーを処理した印で、変換の開始キーは compositionstart より先に届く。
 *   xterm に渡すと、xterm は自分の textarea の変化を探して何も見つけず、既定動作を止めてしまう
 * - `Dead` / `AltGraph`。合成は EditContext の composition が担う。xterm に渡すと xterm は
 *   次のキーを keypress / input に任せる状態に入るが、その 2 経路は xterm に届かない
 */

/** 判定に要るキーイベントの事実。KeyboardEvent をそのまま渡せる */
export type KeyFacts = Pick<KeyboardEvent, "key" | "keyCode" | "isComposing">;

/**
 * - `ime-only`: xterm に渡さず、既定動作も止めない
 * - `xterm-first`: xterm の keydown 処理に渡す。引き受けられなければ EditContext へ落ちる
 */
export type KeyRoute = "ime-only" | "xterm-first";

const IME_PROCESS_KEYCODE = 229;

const COMPOSITION_STARTER_KEYS: ReadonlySet<string> = new Set(["Dead", "AltGraph"]);

export function routeKeyDown(ev: KeyFacts, composing: boolean): KeyRoute {
  if (composing || ev.isComposing || ev.keyCode === IME_PROCESS_KEYCODE) return "ime-only";
  if (COMPOSITION_STARTER_KEYS.has(ev.key)) return "ime-only";
  return "xterm-first";
}
