import type { DirSessionRows } from "../../../session";

/**
 * repo の階層で 1 つの dir に出すセッション行。端末の開いていないセッションは選択中の dir に
 * だけ出す（docs/session.md の「repo の階層」）。
 */
export function visibleSessionRows(rows: DirSessionRows, selected: boolean): DirSessionRows {
  if (selected) return rows;
  return { live: rows.live, inactive: [] };
}

/** 出すセッション行があるか。worktree をカードにするかの判定（docs/workspace.md の「各 worktree」） */
export function hasSessionRows(rows: DirSessionRows): boolean {
  return rows.live.length > 0 || rows.inactive.length > 0;
}
