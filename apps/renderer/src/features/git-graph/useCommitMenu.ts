/**
 * commit 行の右クリック / ⋮ ボタンから開くコンテキストメニューの module singleton。
 *
 * GitGraphPane から `open(anchorEl, { commit })` を呼び、CommitMenu.vue が context を購読
 * して描画する。右クリック経路は呼び出し側で「contextmenu の preventDefault + 次の pointerup
 * を 1 回 capture once で待つ」処理を行ってから open する責務がある (whatwg/html#10905 の
 * light-dismiss を回避するため。spike で検証済み)。
 */
import type { GitCommit } from "@gozd/proto";
import { usePopover } from "../../shared/popover";

type CommitMenuContext = {
  commit: GitCommit;
  dir: string;
  /** 右クリックで開いた場合のマウス座標。指定時は anchor() より優先して使う。
   * ⋮ ボタン経由など anchor 要素基準で出したい場合は undefined。 */
  x?: number;
  y?: number;
};

const popover = usePopover<CommitMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useCommitMenu() {
  return popover;
}
