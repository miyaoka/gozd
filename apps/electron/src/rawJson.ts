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

/** 配列でなければ空配列 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
