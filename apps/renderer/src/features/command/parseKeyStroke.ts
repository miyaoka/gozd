/**
 * キー入力の正規化・比較。
 * VS Code 互換の形式（"alt+cmd+up" 等、全て小文字）を採用する。
 * config 入力形式と KeyboardEvent の両方を KeyStroke に変換し、
 * 内部比較は正規化済みの KeyStroke 同士で行う。
 */
import type { KeyStroke } from "./types";

/** modifier トークンから KeyStroke のフィールドへのマッピング */
const MODIFIER_MAP: Record<string, keyof Pick<KeyStroke, "meta" | "ctrl" | "alt" | "shift">> = {
  cmd: "meta",
  meta: "meta",
  win: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
};

/**
 * DOM KeyboardEvent.key から VS Code 式の短縮名へのエイリアス。
 * KeyboardEvent.key を小文字化した値をキーとする。
 */
const KEY_ALIAS_MAP: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  " ": "space",
};

/** key 名を正規化する。エイリアスがあれば変換、なければそのまま */
function normalizeKey(key: string): string {
  return KEY_ALIAS_MAP[key] ?? key;
}

/**
 * config 入力形式（"alt+cmd+up", "cmd+d" 等）を KeyStroke に変換する。
 * 全て小文字で受け付ける（VS Code 互換）。大文字混在も許容する。
 */
export function parseKeyStroke(input: string): KeyStroke {
  const tokens = input.split("+");
  const stroke: KeyStroke = { key: "", meta: false, ctrl: false, alt: false, shift: false };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (i < tokens.length - 1) {
      // modifier トークン
      const field = MODIFIER_MAP[lower];
      if (field === undefined) {
        throw new Error(`Unknown modifier: "${token}" in "${input}"`);
      }
      stroke[field] = true;
    } else {
      // 最後のトークンは key（小文字化 + エイリアス変換）
      stroke.key = normalizeKey(lower);
    }
  }

  if (stroke.key === "") {
    throw new Error(`No key specified in "${input}"`);
  }

  return stroke;
}

/** KeyboardEvent を KeyStroke に変換する。key は小文字化 + エイリアス変換で正規化 */
export function eventToKeyStroke(e: KeyboardEvent): KeyStroke {
  return {
    key: normalizeKey(e.key.toLowerCase()),
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

/** 二つの KeyStroke が一致するか判定する */
export function matchKeyStroke(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.key === b.key &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}
