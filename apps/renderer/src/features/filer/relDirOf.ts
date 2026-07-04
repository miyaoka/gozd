/**
 * worktree 相対パスから親ディレクトリの worktree 相対表現を返す。
 *
 * main 側 `relativeDir()`（`apps/electron/src/fs/classify.ts`）の出力と一致する形を SSOT とする。
 * - 直下ファイル（"/" を含まないパス）: `""`
 * - サブディレクトリ配下: 末尾 "/" を含まないディレクトリ相対パス
 *
 * fsChange.relDir と選択中ファイルから導出した親 dir を `===` で比較するための境界関数。
 * 表現が乖離すると fsChange の取りこぼしが起きるため、ユニットテストで main 側の出力と
 * 表を揃えて検証する。
 */
export function relDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return "";
  return path.substring(0, idx);
}
