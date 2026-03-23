/**
 * コマンドレジストリ。module singleton パターン。
 * コマンド ID → エントリ（handler + label）のマッピングを管理する。
 */
import { tryCatch } from "@gozd/shared";
import type { CommandEntry, CommandInput } from "./types";

/** CommandInput が記述子（label 付き）かハンドラ関数かを判定 */
function isDescriptor(
  input: CommandInput,
): input is { label: string; handler: (args?: unknown) => boolean } {
  return typeof input !== "function";
}

const entries = new Map<string, CommandEntry>();

/**
 * コマンドを登録する。同一 ID の二重登録は上書き（HMR 安全）。
 * label 付き記述子で登録したコマンドのみパレットに表示される。
 * @returns dispose 関数（登録解除）
 */
function register(id: string, input: CommandInput): () => void {
  const entry: CommandEntry = isDescriptor(input)
    ? { id, label: input.label, handler: input.handler }
    : { id, label: undefined, handler: input };

  entries.set(id, entry);

  return () => {
    // HMR で新しい entry が上書き登録された後に旧 disposer が走っても、
    // 新しい entry を消さないように一致チェックする
    if (entries.get(id) === entry) {
      entries.delete(id);
    }
  };
}

/**
 * コマンドを実行する。
 * @returns handler が true を返した場合 true。未登録または handled=false なら false
 */
function execute(id: string, args?: unknown): boolean {
  const entry = entries.get(id);
  if (entry === undefined) return false;
  const result = tryCatch(() => entry.handler(args));
  if (!result.ok) {
    console.error(`Command "${id}" threw:`, result.error);
    return false;
  }
  return result.value;
}

/**
 * パレット表示用のコマンド一覧を返す。
 * label が設定されているコマンドのみを返す。
 */
function listForPalette(): readonly CommandEntry[] {
  const result: CommandEntry[] = [];
  for (const entry of entries.values()) {
    if (entry.label !== undefined) {
      result.push(entry);
    }
  }
  return result;
}

/** HMR / テスト用。全コマンドを解除する */
function reset(): void {
  entries.clear();
}

export function useCommandRegistry() {
  return { register, execute, listForPalette, reset };
}
