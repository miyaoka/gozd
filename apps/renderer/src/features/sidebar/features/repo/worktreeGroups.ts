import type { DirSessionRows } from "../../../session";
import { hasSessionRows } from "../session-row";

/**
 * worktree 列を間隔の単位に分ける。ヘッダ 1 行で出る worktree が続く間は 1 つのグループに
 * まとめ、カードは 1 件で 1 グループにする。グループ内は詰め、グループどうしはカードの前後の
 * 間隔を空ける。間隔を列の容器が gap だけで持つため、列の端に余白が二重に付かない。
 */
export function groupWorktreeEntries<T extends { sessionRows: DirSessionRows }>(
  entries: T[],
): T[][] {
  const groups: T[][] = [];
  let rowGroup: T[] | undefined;
  for (const entry of entries) {
    if (hasSessionRows(entry.sessionRows)) {
      groups.push([entry]);
      rowGroup = undefined;
      continue;
    }
    if (rowGroup === undefined) {
      rowGroup = [];
      groups.push(rowGroup);
    }
    rowGroup.push(entry);
  }
  return groups;
}
