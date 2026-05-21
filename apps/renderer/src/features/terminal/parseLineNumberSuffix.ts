/** `:行番号` を読み取り、1-based の safe integer のみ採用する SSOT 関数。
 *  `:0` / `Number.isSafeInteger` 外は undefined を返す（呼び出し側で `:N` 自体は consume する想定）。
 *  resolveMarkdownLink.parseAnchor の line fragment 判定と同じ規律。 */
export function parseLineNumberSuffix(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
