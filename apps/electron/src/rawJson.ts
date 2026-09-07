// 信頼できない JSON（永続ファイル / ソケット入力）を型付き message に正規化するための
// 最小ヘルパー。旧 proto3 JSON は default 値のフィールドをキーごと省略して書くため、
// 既存の永続ファイル / nc 直送の固定 JSON には欠落キーがある。読み手側が
// `{ ...DEFAULTS, ...asDict(raw) }` の形で default 充填し、「フィールド不在 = default 値」の
// 契約を維持する（書き手側は常に全フィールドを明示的に書く）。

export type RawDict = Record<string, unknown>;

/** object でなければ空 dict。null / 配列 / primitive を弾く */
export function asDict(value: unknown): RawDict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as RawDict;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// --- strict 版（state 系永続ファイル用: app-state.json / tasks.json） ---
//
// 「フィールド不在 = default」契約は維持しつつ、「存在するが型違反」は契約外の破損として
// RawJsonTypeError を投げる。gozd 自身は型付きで書くため、型違反の現実的な混入経路は
// 手編集 / 異バージョンの書き込みのみで、schema 外データの期待挙動は新規初期化
// （ルート CLAUDE.md のベータ方針）。呼び出し側の load が catch し、TaskStore の
// parse 失敗と同じ「stderr ログ + 初期状態で上書き save (reinit)」経路に倒す。
// 部分救済（違反フィールドだけ default に直す）は書かない。

export class RawJsonTypeError extends Error {
  constructor(label: string, expected: string, value: unknown) {
    super(`${label}: expected ${expected}, got ${describeValue(value)}`);
    this.name = "RawJsonTypeError";
  }
}

export function strictString(value: unknown, label: string, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new RawJsonTypeError(label, "string", value);
  return value;
}

export function strictNumber(value: unknown, label: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new RawJsonTypeError(label, "number", value);
  return value;
}

export function strictBoolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new RawJsonTypeError(label, "boolean", value);
  return value;
}

export function strictStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RawJsonTypeError(label, "array", value);
  return value.map((item, i) => {
    if (typeof item !== "string") throw new RawJsonTypeError(`${label}[${i}]`, "string", item);
    return item;
  });
}

export function strictDictArray(value: unknown, label: string): RawDict[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RawJsonTypeError(label, "array", value);
  return value.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new RawJsonTypeError(`${label}[${i}]`, "object", item);
    }
    return item as RawDict;
  });
}

// --- lenient 版（ユーザー設定ファイル / socket 入力用） ---
//
// 型違反フィールドだけ default に倒して stderr ログを残し、処理は継続する。ファイルには
// 書き戻さない。ユーザー設定は手編集が正規の入力経路（Settings UI の Open settings file）
// なので、typo 一発の全 reinit は過剰（VS Code の「読み側の消費時 validate で default に
// 倒し、ユーザーのファイルは触らない」と同型）。socket は永続物が無く、hook message は
// 落とすと UI 状態が永続的にずれるため message ごと破棄せずフィールド単位で継続する。

function logLenientFallback(label: string, expected: string, value: unknown): void {
  console.error(
    `[rawJson] ${label}: expected ${expected}, got ${describeValue(value)}; using default`,
  );
}

export function lenientString(value: unknown, label: string, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    logLenientFallback(label, "string", value);
    return fallback;
  }
  return value;
}

export function lenientNumber(value: unknown, label: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") {
    logLenientFallback(label, "number", value);
    return fallback;
  }
  return value;
}

export function lenientBoolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    logLenientFallback(label, "boolean", value);
    return fallback;
  }
  return value;
}

/** 「キー不在 = 未設定」を undefined で表現する optional フィールド用 */
export function lenientOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    logLenientFallback(label, "number", value);
    return undefined;
  }
  return value;
}

/** 「キー不在 = 未設定」を undefined で表現する optional フィールド用 */
export function lenientOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    logLenientFallback(label, "boolean", value);
    return undefined;
  }
  return value;
}

/** 文字列配列の lenient 版。非配列は空配列に倒し、非文字列要素は落とす（いずれもログ） */
export function lenientStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    logLenientFallback(label, "array", value);
    return [];
  }
  return value.filter((item, i): item is string => {
    if (typeof item === "string") return true;
    logLenientFallback(`${label}[${i}]`, "string", item);
    return false;
  });
}

/** セクション全体（nested dict）の型違反を default（空 dict）に倒す lenient 版 */
export function lenientDict(value: unknown, label: string): RawDict {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    logLenientFallback(label, "object", value);
    return {};
  }
  return value as RawDict;
}
