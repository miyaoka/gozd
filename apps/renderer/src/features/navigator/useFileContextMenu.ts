/**
 * Filer / Changes のファイル行の右クリックメニュー (module singleton)。
 *
 * NavigatorPane が `open(anchorEl, { dir, relPath, commitHash, x, y })` を呼び、FileContextMenu.vue
 * が context を購読して描画する。FilerPane / ChangesPane (および配下の TreeItem) は navigator を
 * 直接 import せず、`@contextMenu` event の bubble だけを担当する (依存方向を navigator → 子の
 * 1 方向に保つため)。
 *
 * `dir` / `commitHash` は **右クリック時点で navigator が snapshot** して context に焼き付ける。
 * defer 中 / メニュー表示中に worktree や commit 選択が切り替わっても、その右クリックで参照した
 * 当時の値を一貫して使う (defer 後に singleton store を読み直すと「古い relPath + 新 dir」の
 * 不整合 race が起きるため)。
 *
 * メニュー側は `joinAbsRel(dir, relPath)` で絶対 path に展開し、`commitHash === undefined` なら
 * 絶対 path のみ、定義されていれば `${hash}\n${絶対 path}` を clipboard に書く。
 *
 * x / y は contextmenu イベント時のマウス座標。指定時はメニュー側で `position: fixed; left/top`
 * を使い、undefined なら CSS Anchor Position で anchor 要素基準で出す (将来の menu 起動経路用)。
 *
 * NavigatorPane は VueUse `useTimeoutFn` で 0ms の defer を効果 scope 連動で行う。同サイクル内
 * open は `popover="auto"` の light-dismiss を mouseup で消化されて即閉じる (whatwg/html#10905)
 * ため、現在の mousedown task を抜けてから showPopover を発火する。defer 経路はマウス /
 * keyboard (Shift+F10) / programmatic dispatch のいずれにも非依存。defer 中に anchor 元
 * component が unmount された (dir 切替・`:key="dir"` 再マウント) ケースは `anchorEl.isConnected`
 * で検出し、debug log を残して open を skip する。
 */
import { usePopover } from "../../shared/popover";

/**
 * 子 pane (FilerPane / ChangesPane / TreeItem) が contextmenu event で navigator まで bubble
 * させる payload の SSOT。各 pane の emit 定義はこの型を `import type` で参照することで、
 * 同 shape を重複定義する事故を防ぐ。type-only import なので runtime 依存は無く、
 * 依存方向 (navigator → 子) は壊れない。
 *
 * commitHash は payload に乗せず NavigatorPane が `useGitGraphStore.contextMenuHash` で
 * SSOT 解決する (Filer の snapshot tree 表示用 hash と copy 用 hash が別 semantics のため、
 * 子 pane に hash 解決責務を分散させない)。
 */
export type FileContextMenuPayload = {
  /** popover の anchor。CSS Anchor Position の anchor 元として使う */
  anchorEl: HTMLElement;
  /** worktree 相対パス */
  relPath: string;
  /** contextmenu イベント時のマウス座標 (`position: fixed; left/top` 用) */
  x: number;
  y: number;
};

type FileContextMenuContext = {
  /** 右クリック時に snapshot した worktree dir (絶対パス) */
  dir: string;
  /** worktree 相対パス */
  relPath: string;
  /** 右クリック時に snapshot した commit hash。working tree なら undefined */
  commitHash?: string;
  /** contextmenu イベント時のマウス座標。指定時は anchor() より優先 */
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
