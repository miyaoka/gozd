/**
 * ターミナル共通設定。
 * theme はリアクティブで、QuickPick でのテーマ選択時にリアルタイム反映される。
 */

import type { XtermTheme } from "@gozd/themes";
import { ref } from "vue";
import DEFAULT_TERMINAL_CONFIG from "./defaultTerminalConfig.json";

export interface TerminalConfig {
  fontSize: number;
  // xterm.js は半角セル幅 × 2 で全角文字を描画するため、
  // 日本語グリフの幅が英字フォント幅の2倍に合う等幅フォントが必要。
  fontFamily: string;
  scrollback: number;
}

/** フォント・スクロールバック等の静的設定 */
export const terminalConfig: TerminalConfig = DEFAULT_TERMINAL_CONFIG;

/**
 * 現在のターミナルテーマ。watch で全 xterm インスタンスに反映される。
 * 未指定のプロパティは xterm.js のデフォルト値が使われる。
 */
export const currentTheme = ref<Partial<XtermTheme>>(DEFAULT_TERMINAL_CONFIG.theme);

/** 現在適用中のテーマ名。未選択（デフォルト）の場合は undefined */
export const currentThemeName = ref<string>();
