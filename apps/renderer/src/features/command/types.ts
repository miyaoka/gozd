/**
 * コマンドシステムの型定義。
 * 循環 import を防ぐため、型はこのファイルに集約する。
 */

// --- コマンド ---

/** コマンドハンドラー。処理した場合 true、何もしなかった場合 false を返す */
export type CommandHandler = (args?: unknown) => boolean;

// --- キー入力 ---

export interface KeyStroke {
  /** 物理キーの e.code 値（"KeyD", "Digit2", "ArrowUp" 等） */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

// --- Context Key ---

/** context key の名前と値型のマッピング */
export interface ContextMap {
  terminalFocus: boolean;
  explorerVisible: boolean;
}

export type ContextKey = keyof ContextMap;

// --- When 条件（内部 AST） ---

export type When =
  | { type: "key"; key: ContextKey }
  | { type: "not"; value: When }
  | { type: "and"; values: readonly When[] }
  | { type: "or"; values: readonly When[] };

// --- Keybinding ---

/**
 * keybinding 定義。全フィールドが文字列（JSON 互換）。
 * command が "-" prefix の場合は unbind（該当エントリの打ち消し）。
 */
export interface KeyBinding {
  /** VS Code 互換形式: "cmd+d", "alt+cmd+up" */
  key: string;
  /** "terminal.splitHorizontal" or "-terminal.splitHorizontal"（unbind） */
  command: string;
  /** VS Code 互換の when 文字列: "terminalFocus", "terminalFocus && !explorerVisible" */
  when?: string;
}
