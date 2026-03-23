/**
 * コマンドパレットでのキーバインド表示用ユーティリティ。
 * defaultKeyBindings.json からコマンド ID → キー文字列のマッピングを構築し、
 * macOS 向けの記号表記に変換する。
 */
import { DEFAULT_KEY_BINDINGS } from "../../shared/command";

/** modifier の macOS 記号マッピング */
const MODIFIER_SYMBOLS: Record<string, string> = {
  ctrl: "\u2303",
  alt: "\u2325",
  shift: "\u21E7",
  cmd: "\u2318",
};

/** 特殊キーの表示名マッピング */
const KEY_DISPLAY: Record<string, string> = {
  left: "\u2190",
  right: "\u2192",
  up: "\u2191",
  down: "\u2193",
  enter: "\u21A9",
  escape: "Esc",
  space: "Space",
  tab: "Tab",
  backspace: "\u232B",
  delete: "\u2326",
};

/**
 * コマンド ID → キー文字列（"shift+cmd+p" 等）のマッピングを返す。
 * unbind エントリ（"-" prefix）は除外。同一コマンドに複数のバインドがある場合は最初のものを使用。
 */
export function getKeyBindingMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const binding of DEFAULT_KEY_BINDINGS) {
    if (binding.command.startsWith("-")) continue;
    if (map.has(binding.command)) continue;
    map.set(binding.command, binding.key);
  }
  return map;
}

/**
 * キー文字列（"shift+cmd+p"）を macOS 記号表記（"⇧⌘P"）に変換する。
 */
export function formatKeyBinding(key: string): string {
  const parts = key.split("+");
  const result: string[] = [];

  for (const part of parts) {
    const symbol = MODIFIER_SYMBOLS[part];
    if (symbol !== undefined) {
      result.push(symbol);
      continue;
    }
    const display = KEY_DISPLAY[part];
    if (display !== undefined) {
      result.push(display);
      continue;
    }
    // 通常のキー: 大文字で表示
    result.push(part.toUpperCase());
  }

  return result.join("");
}
