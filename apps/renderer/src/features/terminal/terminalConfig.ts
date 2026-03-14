/** ターミナル共通設定。ghostty-web / xterm.js 両バックエンドで共有する。 */

export const TERMINAL_FONT_SIZE = 13;

// xterm.js は半角セル幅 × 2 で全角文字を描画するため、
// 日本語グリフの幅が英字フォント幅の2倍に合う等幅フォントが必要。
// TODO: ユーザー設定で上書きできるようにする
export const TERMINAL_FONT_FAMILY = "'UDEV Gothic 35NF', Menlo, monospace";

export const TERMINAL_THEME = {
  background: "#18181b", // zinc-900
  foreground: "#e4e4e7", // zinc-200
  cursor: "#e4e4e7",
};
