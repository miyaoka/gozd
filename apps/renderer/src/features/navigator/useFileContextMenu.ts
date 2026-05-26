/**
 * Filer / Changes のファイル行の右クリックメニュー (module singleton)。
 *
 * NavigatorPane が `open(anchorEl, { relPath, commitHash, x, y })` を呼び、FileContextMenu.vue が
 * context を購読して描画する。FilerPane / ChangesPane (および配下の TreeItem) は navigator を
 * 直接 import せず、`@contextMenu` event の bubble だけを担当する (依存方向を navigator → 子の
 * 1 方向に保つため)。
 *
 * relPath は worktree 相対パス。メニュー側で active worktree dir と join して絶対パスに展開し、
 * その絶対パスを clipboard に書く。commitHash は working tree のとき undefined、snapshot /
 * commit 由来のとき hash 値。メニュー側はこの discriminator を見て copy 文字列の組み立てを切り
 * 替える (working: 絶対パスのみ / commit 由来: `${hash}\n${絶対パス}`)。
 *
 * x / y は contextmenu イベント時のマウス座標。指定時はメニュー側で `position: fixed; left/top`
 * を使い、undefined なら CSS Anchor Position で anchor 要素基準で出す (将来の menu 起動経路用)。
 *
 * NavigatorPane は `setTimeout(open, 0)` で open を 1 task 分遅延させる責務を持つ。`popover="auto"`
 * を contextmenu 同サイクル内で開くと mousedown が light-dismiss を予約し続く mouseup で即閉じる
 * (whatwg/html#10905) ため、現在の mousedown task を抜けてから showPopover を発火させる。
 * setTimeout 経路はマウス / キーボード (Shift+F10) / programmatic dispatch のいずれにも非依存に
 * 動く (pointerup 待機経路はマウス右クリックに限定されるため採用しない)。
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
  /** worktree 相対パス */
  relPath: string;
  /** snapshot / commit 由来のとき commit hash。working tree なら undefined */
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
