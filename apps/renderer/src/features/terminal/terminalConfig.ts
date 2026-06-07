/**
 * ターミナル共通設定。
 * theme・font はリアクティブで、設定変更時にリアルタイム反映される。
 */

import type { XtermTheme } from "@gozd/themes";
import { ref } from "vue";

/** xterm.js は CSS variable を受け付けず hex (or rgb) を要求するため、design token
 * の `--color-*` から runtime で hex 文字列に変換する。canvas 2D の fillStyle は
 * 任意 CSS color (OKLCH 含む) を parse して canonical form (#rrggbb / rgb(...)) を
 * 返すため、外部 lib なしで OKLCH → hex 変換が可能。
 *
 * design-tokens は build 時に `:root` の CSS variable を出力するため、本 module の
 * import 時点では document.documentElement に既に値が乗っている (Vite が CSS を
 * head に inject してから JS module を実行する)。 */
function resolveTokenColor(cssVar: string): string {
  /* bun test 等の non-DOM 環境では undefined を返して空に倒す。xterm.js は実 app
   * 起動時にしか使われないため空でも runtime 影響なし */
  if (typeof document === "undefined") return "";
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  if (value === "") return "";
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) return "";
  ctx.fillStyle = value;
  return ctx.fillStyle as string;
}

/** xterm.js に未指定時のデフォルトテーマカラー。applyTerminalTheme("") でもこの値に戻す */
export const DEFAULT_THEME: Partial<XtermTheme> = {
  background: resolveTokenColor("--color-background"),
  foreground: resolveTokenColor("--color-foreground"),
  cursor: resolveTokenColor("--color-foreground"),
};

const SCROLLBACK = 10000;

/** スクロールバック行数 */
export const terminalScrollback = SCROLLBACK;

/** リアクティブなフォント設定。空文字 / 0 は未設定（xterm デフォルトに委ねる） */
export const terminalFontFamily = ref("");
export const terminalFontSize = ref(0);

/**
 * 現在のターミナルテーマ。watch で全 xterm インスタンスに反映される。
 * 未指定のプロパティは xterm.js のデフォルト値が使われる。
 */
export const currentTheme = ref<Partial<XtermTheme>>(DEFAULT_THEME);

/** 現在適用中のテーマ名。未選択（デフォルト）の場合は undefined */
export const currentThemeName = ref<string>();
