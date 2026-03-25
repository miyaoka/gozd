/**
 * ドット記法でネストされたオブジェクトにアクセスするユーティリティ。
 * "voicevox.speedScale" のようなキーで { voicevox: { speedScale: 1.5 } } を読み書きする。
 */

/** ドット区切りキーでネストされた値を取得する */
export function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** ドット区切りキーでネストされた値を設定する。中間オブジェクトがなければ作成する */
export function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  current[lastPart] = value;
}
