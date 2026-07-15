/**
 * git-graph の commit 行の右クリックメニュー (module singleton)。popover の open / context 購読を
 * 担い、CommitContextMenu.vue が描画する。menu アクションは CommitContextMenu.vue の doc を参照。
 *
 * `dir` / `hash` は右クリック時点で snapshot して context に焼き付ける。後で worktree 切替 /
 * commit 選択 / git log 再取得が走っても、その右クリックで指した当時の値を一貫して使う
 * (open 後に live store / commits を読み直すと「古い row + 新 dir」の不整合が起きるため)。
 *
 * x / y は contextmenu イベント時のマウス座標。指定時はメニュー側で `position: fixed; left/top`
 * を使い、undefined なら CSS Anchor Position で anchor 要素基準で出す。
 *
 * open を pointerup まで遅延させて WebKit の light-dismiss を回避する仕組みと、その不変条件は
 * listener 実装と同居する `useCommitContextMenuTrigger.ts` に置く。
 */
import { usePopover } from "../../../../shared/popover";

type CommitContextMenuContext = {
  /** 右クリック時に snapshot した worktree dir (絶対パス) */
  dir: string;
  /** 右クリックした commit の hash (full)。working tree 行はメニュー対象外なので必ず実 commit */
  hash: string;
  /** contextmenu イベント時のマウス座標。指定時は anchor() より優先 */
  x?: number;
  y?: number;
};

const popover = usePopover<CommitContextMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useCommitContextMenu() {
  return popover;
}
