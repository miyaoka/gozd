import type { DirSessionRows } from "../../../session";

/**
 * repo の階層で 1 つの dir に出すセッション行。端末の開いていないセッションは選択中の dir に
 * だけ出し、それ以外の dir は端末の開いているセッションだけにする。過去のセッションを全 dir に
 * 出すと、稼働中のセッションが過去の行に埋もれて一覧で見分けられなくなるため。
 */
export function visibleSessionRows(rows: DirSessionRows, selected: boolean): DirSessionRows {
  if (selected) return rows;
  return { live: rows.live, inactive: [] };
}
