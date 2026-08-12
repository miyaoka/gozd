import type { FileRealTarget } from "./filerUtils";

/**
 * ファイル行 (FilerPane / ChangesPane / TreeItem) が contextmenu event で親 (navigator) まで
 * bubble させる payload の SSOT。各 pane の emit 定義はこの型を `import type` で参照することで、
 * 同 shape を重複定義する事故を防ぐ。発火側の共通基盤である filer が realTarget の型
 * (`FileRealTarget`) と併せて所有し、受け手 (navigator) は filer から型を参照する。
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
  /**
   * 実体がツリー上のパスと食い違う行のとき、その実体の在り処 (実体向け項目の対象)。
   * 既存項目 (Open / Copy file / Copy path) は relPath 側で動き続けるため両者は独立に共存する。
   * undefined になるのは実体がツリー上のパスと一致する行と、実体を解決できない行 (dangling / 循環)。
   * worktree 外の実体では定義され (`relPath` だけ undefined)、どの項目を出すかは menu 側が決める。
   */
  realTarget?: FileRealTarget;
  /** contextmenu イベント時のマウス座標 (`position: fixed; left/top` 用) */
  x: number;
  y: number;
};
