/**
 * file picker のフィルタ + ランキング純粋関数。
 * fuzzyMatch（fzf V2 ライク）でパス全体をスコアリングし、上位 limit 件だけ返す。
 * 描画とキーボードナビゲーションのコストを抑えるため全マッチは返さない
 * （VS Code の Quick Open も同様に上限で打ち切る戦略）。
 */

import { fuzzyMatch } from "../../fuzzyMatch";

/** 表示する最大件数。これを超えるマッチはクエリを絞り込んで到達する前提 */
export const FILE_PICKER_MAX_RESULTS = 100;

export function filterFiles(files: string[], query: string): string[] {
  if (query === "") return files.slice(0, FILE_PICKER_MAX_RESULTS);

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const result = fuzzyMatch(path, query);
    if (result) {
      scored.push({ path, score: result.score });
    }
  }
  // 同点は短いパス優先（fzf の --tiebreak=length 既定と同じ）。マッチ文脈が同一な
  // `src/info.ts` と `src/information/deep.ts`（query "info"）のようなケースで、
  // より的を絞った候補を上に出す。それも同点なら stable sort が入力順を保つ
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, FILE_PICKER_MAX_RESULTS).map((s) => s.path);
}
