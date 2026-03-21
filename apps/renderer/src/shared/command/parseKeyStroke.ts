/**
 * キー入力の正規化・比較。
 * VS Code 互換の形式（"alt+cmd+up" 等、全て小文字）を採用する。
 * 内部表現は e.code（物理キー）ベース。e.key はレイアウト依存のため使用しない。
 *
 * config の key 名は以下のルールで e.code 値に変換する:
 * - 英字: "d" → "KeyD"
 * - 数字: "2" → "Digit2"
 * - 矢印: "up" → "ArrowUp"
 * - 特殊キー: "enter" → "Enter", "space" → "Space" 等
 * - 角括弧記法: "[BracketLeft]" → "BracketLeft"（e.code を直接指定）
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

/** config の key 名（小文字）から e.code 値へのマッピング */
const KEY_TO_CODE: Record<string, string> = {
  // 英字
  a: "KeyA",
  b: "KeyB",
  c: "KeyC",
  d: "KeyD",
  e: "KeyE",
  f: "KeyF",
  g: "KeyG",
  h: "KeyH",
  i: "KeyI",
  j: "KeyJ",
  k: "KeyK",
  l: "KeyL",
  m: "KeyM",
  n: "KeyN",
  o: "KeyO",
  p: "KeyP",
  q: "KeyQ",
  r: "KeyR",
  s: "KeyS",
  t: "KeyT",
  u: "KeyU",
  v: "KeyV",
  w: "KeyW",
  x: "KeyX",
  y: "KeyY",
  z: "KeyZ",
  // 数字
  "0": "Digit0",
  "1": "Digit1",
  "2": "Digit2",
  "3": "Digit3",
  "4": "Digit4",
  "5": "Digit5",
  "6": "Digit6",
  "7": "Digit7",
  "8": "Digit8",
  "9": "Digit9",
  // 矢印
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  // 特殊キー
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  // ファンクションキー
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
  // 記号（US レイアウト基準）
  ";": "Semicolon",
  "=": "Equal",
  "-": "Minus",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "'": "Quote",
  ",": "Comma",
};

/**
 * config の key トークンを e.code 値に変換する。
 * - 角括弧記法 "[BracketLeft]" → "BracketLeft"
 * - KEY_TO_CODE マッピング
 */
function keyToCode(token: string): string {
  // 角括弧記法: e.code を直接指定
  if (token.startsWith("[") && token.endsWith("]")) {
    return token.slice(1, -1);
  }

  const code = KEY_TO_CODE[token];
  if (code !== undefined) return code;

  throw new Error(`Unknown key: "${token}". Use [Code] syntax for physical key codes.`);
}

/**
 * config 入力形式（"alt+cmd+up", "cmd+d" 等）を KeyStroke に変換する。
 * 全て小文字で受け付ける（VS Code 互換）。大文字混在も許容する。
 */
export function parseKeyStroke(input: string): KeyStroke {
  const tokens = input.split("+");
  const stroke: KeyStroke = { code: "", meta: false, ctrl: false, alt: false, shift: false };

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
      // 最後のトークンは key
      // modifier 名が末尾に来た場合は設定ミス
      if (MODIFIER_MAP[lower] !== undefined) {
        throw new Error(`Key is a modifier name: "${token}" in "${input}"`);
      }
      // 角括弧記法は e.code を直接指定するため、大文字を保持して渡す
      stroke.code = keyToCode(token.startsWith("[") ? token : lower);
    }
  }

  if (stroke.code === "") {
    throw new Error(`No key specified in "${input}"`);
  }

  return stroke;
}

/** KeyboardEvent を KeyStroke に変換する。e.code（物理キー）を使用 */
export function eventToKeyStroke(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): KeyStroke {
  return {
    code: e.code,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

/** 二つの KeyStroke が一致するか判定する */
export function matchKeyStroke(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.code === b.code &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}
