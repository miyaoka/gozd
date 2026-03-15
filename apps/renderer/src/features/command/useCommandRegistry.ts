/**
 * コマンドレジストリ。module singleton パターン。
 * コマンド ID → handler のマッピングを管理する。
 */
import type { CommandHandler } from "./types";

const handlers = new Map<string, CommandHandler>();

/**
 * コマンドを登録する。同一 ID の二重登録はエラー。
 * @returns dispose 関数（登録解除）
 */
function register(id: string, handler: CommandHandler): () => void {
  if (handlers.has(id)) {
    throw new Error(`Command already registered: "${id}"`);
  }
  handlers.set(id, handler);
  return () => {
    handlers.delete(id);
  };
}

/**
 * コマンドを実行する。
 * @returns handler が true を返した場合 true。未登録または handled=false なら false
 */
function execute(id: string, args?: unknown): boolean {
  const handler = handlers.get(id);
  if (handler === undefined) return false;
  return handler(args);
}

/** HMR / テスト用。全コマンドを解除する */
function reset(): void {
  handlers.clear();
}

export function useCommandRegistry() {
  return { register, execute, reset };
}
