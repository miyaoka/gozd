/**
 * ターミナル共通設定。
 * theme・font はリアクティブで、設定変更時にリアルタイム反映される。
 */

import type { XtermTheme } from "@gozd/themes";
import { ref } from "vue";

/** xterm.js は CSS variable を受け付けず hex / rgb literal を要求するため、
 * design token の `--color-*` を runtime で literal に変換する。canvas 2D の
 * fillStyle setter は CSS color parser を通すため、OKLCH を含む任意 CSS color
 * を canonical form (`#rrggbb` / `rgb(...)`) に解決する。
 *
 * `getDefaultTheme` は **xterm.js spawn 時** に呼ばれ、その時点では design-tokens
 * の CSS は確実に DOM に load 済み。module top-level での同期評価は避ける
 * (CSS の load 順序と JS module evaluation の順序保証がない)。
 *
 * 失敗は silent fallback せず throw する (CLAUDE.md 規約):
 *   - CSS variable 未解決 → CSS が load 前に呼ばれている。bug
 *   - canvas context unavailable → renderer 環境異常。bug
 */
function resolveTokenColor(cssVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  if (value === "") {
    throw new Error(
      `Design token ${cssVar} is unresolved. @gozd/design-tokens CSS must be loaded before terminal init.`,
    );
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) {
    throw new Error(
      `Canvas 2D context unavailable; cannot resolve ${cssVar} to xterm color literal.`,
    );
  }
  ctx.fillStyle = value;
  return ctx.fillStyle as string;
}

/** xterm.js spawn 時に呼ぶ。design token から literal color を解決して返す */
export function getDefaultTheme(): Partial<XtermTheme> {
  const fg = resolveTokenColor("--color-foreground");
  return {
    background: resolveTokenColor("--color-background"),
    foreground: fg,
    cursor: fg,
  };
}

const SCROLLBACK = 10000;

/** スクロールバック行数 */
export const terminalScrollback = SCROLLBACK;

/** リアクティブなフォント設定。空文字 / 0 は未設定（xterm デフォルトに委ねる） */
export const terminalFontFamily = ref("");
export const terminalFontSize = ref(0);

/**
 * 現在のターミナルテーマ。watch で全 xterm インスタンスに反映される。
 * 初期値は空 object。実際の default theme は xterm spawn 時に getDefaultTheme()
 * で解決して入れる (CSS load タイミング保証のため module top-level 評価しない)。
 */
export const currentTheme = ref<Partial<XtermTheme>>({});

/** 現在適用中のテーマ名。未選択（デフォルト）の場合は undefined */
export const currentThemeName = ref<string>();
