/**
 * Filer / Changes のファイル行の右クリックメニュー (module singleton)。
 *
 * 親側 (FileTreeItem / ChangesTreeItem) から `open(anchorEl, { relPath, commitHash, x, y })` を
 * 呼び、NavigatorPane に置いた FileContextMenu.vue が context を購読して描画する。
 *
 * relPath は worktree 相対パス。メニュー側で active worktree dir と join して絶対パスに展開し、
 * その絶対パスを clipboard に書く。
 *
 * commitHash は working tree のとき undefined、snapshot / commit 由来のとき hash 値。
 * メニュー側はこの discriminator を見て copy 文字列の組み立てを切り替える。
 *
 * x / y は右クリック時のマウス座標。指定時はメニュー側で `position: fixed; left/top` を使い、
 * undefined なら CSS Anchor Position で anchor 要素基準で出す (⋮ ボタン経由など)。
 *
 * 右クリック経路は呼び出し側で「contextmenu の preventDefault + 次の pointerup を 1 回
 * capture once で待つ」処理を行ってから open する責務がある (whatwg/html#10905 の
 * light-dismiss を回避するため。`popover="auto"` の dismiss が mousedown 時点で予約され
 * mouseup で消化される問題)。
 */
import { usePopover } from "../../shared/popover";

type FileContextMenuContext = {
  /** worktree 相対パス */
  relPath: string;
  /** snapshot / commit 由来のとき commit hash。working tree なら undefined */
  commitHash?: string;
  /** 右クリックで開いた場合のマウス座標。指定時は anchor() より優先 */
  x?: number;
  y?: number;
};

const popover = usePopover<FileContextMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useFileContextMenu() {
  return popover;
}
