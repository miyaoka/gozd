/** ASCII strict (locale 非依存) な string 比較。Array.prototype.sort 用 comparator。
 *
 * `String.prototype.localeCompare` は実行 locale 依存で codegen / test の決定性を
 * 損なうため、generator (生成ファイルのエントリ順) と test (smoke test の name 順)
 * の両方で本関数を SSOT として参照する。
 */
export function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
