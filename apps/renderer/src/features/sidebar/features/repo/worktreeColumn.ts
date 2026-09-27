import type { DirSessionRows } from "../../../session";
import { hasSessionRows } from "../session-row";

/** worktree 列の 1 要素。worktree か、カードの前後を空ける区切り */
export type WorktreeColumnItem<T> =
  | { kind: "worktree"; key: string; entry: T }
  | { kind: "separator"; key: string };

/**
 * worktree 列を、worktree と区切りが混ざった平らな列にする。区切りはカードとその隣の境目にだけ
 * 置き、列の端には置かない。ヘッダ 1 行の worktree どうしは容器の gap だけで詰まる。
 *
 * 全 worktree を 1 つの親の直下に保つため、グループの入れ物で包まない。包むとカードか 1 行かが
 * 変わるたびに worktree が別の親へ移り、Vue が作り直してフォーカスを失う。
 */
export function buildWorktreeColumn<T extends { path: string; sessionRows: DirSessionRows }>(
  entries: T[],
): WorktreeColumnItem<T>[] {
  const items: WorktreeColumnItem<T>[] = [];
  let prev: T | undefined;
  for (const entry of entries) {
    if (
      prev !== undefined &&
      (hasSessionRows(prev.sessionRows) || hasSessionRows(entry.sessionRows))
    ) {
      items.push({ kind: "separator", key: `separator:${entry.path}` });
    }
    items.push({ kind: "worktree", key: entry.path, entry });
    prev = entry;
  }
  return items;
}
