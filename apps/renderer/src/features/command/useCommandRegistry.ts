/**
 * コマンドレジストリ。module singleton パターン。
 * コマンド ID → handler のマッピングを管理する。
 */
import { tryCatch } from "@gozd/shared";
import type { CommandHandler } from "./types";

const handlers = new Map<string, CommandHandler>();

/**
 * コマンドを登録する。同一 ID の二重登録は上書き（HMR 安全）。
 * @returns dispose 関数（登録解除）
 */
function register(id: string, handler: CommandHandler): () => void {
  handlers.set(id, handler);
  return () => {
    // HMR で新しい handler が上書き登録された後に旧 disposer が走っても、
    // 新しい handler を消さないように一致チェックする
    if (handlers.get(id) === handler) {
      handlers.delete(id);
    }
  };
}

/**
 * コマンドを実行する。
 * @returns handler が true を返した場合 true。未登録または handled=false なら false
 */
function execute(id: string, args?: unknown): boolean {
  const handler = handlers.get(id);
  if (handler === undefined) return false;
  const result = tryCatch(() => handler(args));
  if (!result.ok) {
    console.error(`Command "${id}" threw:`, result.error);
    return false;
  }
  return result.value;
}

/** HMR / テスト用。全コマンドを解除する */
function reset(): void {
  handlers.clear();
}

export function useCommandRegistry() {
  return { register, execute, reset };
}
