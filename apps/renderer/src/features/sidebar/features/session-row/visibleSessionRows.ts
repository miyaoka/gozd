import type { DirSessionRows } from "../../../session";

/**
 * repo の階層で 1 つの dir に出すセッション行。端末の開いていないセッションは選択中の dir に
 * だけ出す（docs/session.md の「repo の階層」）。
 */
export function visibleSessionRows(rows: DirSessionRows, selected: boolean): DirSessionRows {
  if (selected) return rows;
  return { live: rows.live, inactive: [] };
}
