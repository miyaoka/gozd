/**
 * ターミナル共通設定。ghostty-web / xterm.js 両バックエンドで共有する。
 * 将来的にユーザー設定で Partial<TerminalConfig> をマージして上書きする。
 */

import DEFAULT_TERMINAL_CONFIG from "./defaultTerminalConfig.json";

export interface TerminalConfig {
  fontSize: number;
  // xterm.js は半角セル幅 × 2 で全角文字を描画するため、
  // 日本語グリフの幅が英字フォント幅の2倍に合う等幅フォントが必要。
  fontFamily: string;
  scrollback: number;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
  };
}

// TODO: ユーザー設定で上書きできるようにする
export const terminalConfig: TerminalConfig = DEFAULT_TERMINAL_CONFIG;
