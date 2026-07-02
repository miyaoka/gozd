import { UNCOMMITTED_HASH } from "../worktree";

/**
 * git-graph の範囲選択を時系列順に整列した {newer, older}。
 * compareHash が null の単一選択時は older は undefined。
 */
export interface OrderedRange {
  newer: string;
  older: string | undefined;
}

/**
 * 選択 hash ペアを時系列順に整列する。
 * hashToIndex は commits[0] が newest（小さい idx ほど新しい）前提の index map。
 * UNCOMMITTED_HASH は idx=-1 扱いで常に newer 側。
 *
 * 不整合（commits 未ロード / stale 選択 / 両端 UNCOMMITTED）のときは null を返す。
 * 呼び出し側で UI fallback（fetchCommitContent はエラー化、ラベルは "Original" の hash 表記なしに倒す）。
 * 黙って older 側に倒すと選択順依存のバグが再発するため fallback では絶対に補わない。
 */
export function orderCommitRange(
  selected: string,
  compare: string | null,
  hashToIndex: ReadonlyMap<string, number>,
): OrderedRange | null {
  if (compare === null) return { newer: selected, older: undefined };

  // 両端 UNCOMMITTED_HASH は store API レイヤーでガードしていない不整合。null を返す。
  if (selected === UNCOMMITTED_HASH && compare === UNCOMMITTED_HASH) return null;

  const idx = (h: string) => {
    if (h === UNCOMMITTED_HASH) return -1;
    return hashToIndex.get(h);
  };
  const selectedIdx = idx(selected);
  const compareIdx = idx(compare);
  if (selectedIdx === undefined || compareIdx === undefined) return null;
  // idx が大きい方が older
  if (selectedIdx >= compareIdx) return { newer: compare, older: selected };
  return { newer: selected, older: compare };
}
