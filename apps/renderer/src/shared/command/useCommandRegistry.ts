/**
 * コマンドレジストリ。module singleton パターン。
 * コマンド ID → エントリ（handler / label / precondition / 既定 keybinding）の登録簿。
 *
 * 既定 keybinding が記述子に同居するため、打鍵から実行コマンドを決める解決点もここが持つ
 * （`resolveKeyBinding`）。listener を張るのは useKeyBindings 側。
 */
import { tryCatch } from "@gozd/shared";
import { matchKeyStroke, parseKeyStroke } from "./parseKeyStroke";
import { parseWhen } from "./parseWhen";
import type {
  CommandDescriptor,
  CommandEntry,
  CommandInput,
  KeyStroke,
  ResolvedKeyBinding,
  When,
} from "./types";
import { useContextKeys } from "./useContextKeys";

/** CommandInput が記述子（label 付き）かハンドラ関数かを判定 */
function isDescriptor(input: CommandInput): input is CommandDescriptor {
  return typeof input !== "function";
}

/** エラー通知コールバック。feature 層から注入して shared 間の依存を回避する。未設定時は console.error にフォールバック */
let onError: (message: string, cause?: unknown) => void = console.error;

function setErrorHandler(handler: (message: string, cause?: unknown) => void) {
  onError = handler;
}

/** precondition と when を AND した実効条件を作る（VS Code の registerAction2 と同じ合成） */
function combineWhen(precondition: When | undefined, when: When | undefined): When | undefined {
  if (precondition === undefined) return when;
  if (when === undefined) return precondition;
  return { type: "and", values: [precondition, when] };
}

/** 既定 keybinding を登録時に parse する（key / when 文字列の誤りは register 時点で throw させる） */
function buildKeyBinding(
  descriptor: CommandDescriptor,
  precondition: When | undefined,
): ResolvedKeyBinding | undefined {
  const { keybinding } = descriptor;
  if (keybinding === undefined) return undefined;
  const keys = Array.isArray(keybinding.key) ? keybinding.key : [keybinding.key];
  return {
    keys,
    strokes: keys.map(parseKeyStroke),
    when: combineWhen(precondition, parseWhen(keybinding.when)),
  };
}

const entries = new Map<string, CommandEntry>();

/**
 * コマンドを登録する。同一 ID の二重登録は上書き（HMR 安全）。
 * label 付き記述子で登録したコマンドのみパレットに表示される。
 * @returns dispose 関数（登録解除）
 */
function register(id: string, input: CommandInput): () => void {
  const precondition = isDescriptor(input) ? parseWhen(input.precondition) : undefined;
  const entry: CommandEntry = isDescriptor(input)
    ? {
        id,
        label: input.label,
        handler: input.handler,
        precondition,
        keybinding: buildKeyBinding(input, precondition),
      }
    : { id, label: undefined, handler: input, precondition: undefined, keybinding: undefined };

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
  if (entry === undefined) {
    // コマンドは動的登録される文字列 namespace なので id の存在は静的に型検査できない
    // （VSCode も同様で id は string）。未登録 id を silent-false で握りつぶすと、rename / typo /
    // 登録漏れで呼び出し側（サイドバーのボタン等）が無反応のまま壊れる。VSCode の
    // CommandService が未知コマンドを reject するのと同じく、実行時に fail-loud で観測可能化する
    // （silent drop 禁止）。契約は boolean のまま保ち、通知は注入済みのエラーチャネル
    // （handler throw と同じ口）に流す。
    //
    // この分岐に到達するのは id 文字列を直接渡す呼び出し側（サイドバーのボタン等）だけ。
    // keybinding は entry に同居するため、未登録コマンドを指すキー割り当ては存在し得ない
    // （未登録 = キー割り当ても消えている = ブラウザ既定に抜ける）。
    onError(`Command "${id}" not found`);
    return false;
  }
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
 * この keystroke で実行するコマンドを決める。条件は register 時に precondition と AND 済み。
 *
 * 優先度は持たず、同一キーの割り当ては実効条件で排他にする契約。破れた場合は登録順
 * （= コンポーネントの mount 順）で先勝ちし再現しないため、観測可能化する（silent drop 禁止）。
 */
function resolveKeyBinding(stroke: KeyStroke): CommandEntry | undefined {
  const contextKeys = useContextKeys();
  const matched = [...entries.values()].filter(
    (entry) =>
      entry.keybinding !== undefined &&
      entry.keybinding.strokes.some((s) => matchKeyStroke(stroke, s)) &&
      contextKeys.evaluate(entry.keybinding.when),
  );

  const [first, ...rest] = matched;
  if (rest.length > 0) {
    onError(`Keybinding conflict: ${matched.map((entry) => entry.id).join(", ")}`);
  }
  return first;
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
  return { register, execute, resolveKeyBinding, listForPalette, reset, setErrorHandler };
}
