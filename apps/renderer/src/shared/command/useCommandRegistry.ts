/**
 * コマンドレジストリ。module singleton パターン。
 * コマンド ID → エントリ（handler + label）のマッピングを管理する。
 */
import { tryCatch } from "@gozd/shared";
import { parseWhen } from "./parseWhen";
import type { CommandEntry, CommandInput } from "./types";
import { useContextKeys } from "./useContextKeys";

/** CommandInput が記述子（label 付き）かハンドラ関数かを判定 */
function isDescriptor(
  input: CommandInput,
): input is { label: string; handler: (args?: unknown) => boolean } {
  return typeof input !== "function";
}

const entries = new Map<string, CommandEntry>();

/** エラー通知コールバック。feature 層から注入して shared 間の依存を回避する。未設定時は console.error にフォールバック */
let onError: (message: string, cause?: unknown) => void = console.error;

function setErrorHandler(handler: (message: string, cause?: unknown) => void) {
  onError = handler;
}

/**
 * コマンドを登録する。同一 ID の二重登録は上書き（HMR 安全）。
 * label 付き記述子で登録したコマンドのみパレットに表示される。
 * @returns dispose 関数（登録解除）
 */
function register(id: string, input: CommandInput): () => void {
  const entry: CommandEntry = isDescriptor(input)
    ? {
        id,
        label: input.label,
        handler: input.handler,
        precondition: parseWhen(input.precondition),
      }
    : { id, label: undefined, handler: input, precondition: undefined };

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
  // precondition が false ならスキップ（キーバインド等からの実行も防止）
  const contextKeys = useContextKeys();
  if (!contextKeys.evaluate(entry.precondition)) return false;
  const result = tryCatch(() => entry.handler(args));
  if (!result.ok) {
    onError(`Command "${id}" threw`, result.error);
    return false;
  }
  return result.value;
}

/**
 * パレット表示用のコマンド一覧を返す。
 * label が設定されており、precondition が true のコマンドのみを返す。
 */
function listForPalette(): readonly CommandEntry[] {
  const contextKeys = useContextKeys();
  const result: CommandEntry[] = [];
  for (const entry of entries.values()) {
    if (entry.label !== undefined && contextKeys.evaluate(entry.precondition)) {
      result.push(entry);
    }
  }
  return result;
}

/** HMR / テスト用。全コマンドを解除する */
function reset(): void {
  entries.clear();
  onError = console.error;
}

export function useCommandRegistry() {
  return { register, execute, listForPalette, reset, setErrorHandler };
}
