/**
 * Filer / Changes のファイル行の右クリックメニュー (module singleton)。
 *
 * NavigatorPane が `open(anchorEl, { dir, relPath, commitHash, x, y })` を呼び、FileContextMenu.vue
 * が context を購読して描画する。FilerPane / ChangesPane (および配下の TreeItem) は navigator を
 * 直接 import せず、`@contextMenu` event の bubble だけを担当する (依存方向を navigator → 子の
 * 1 方向に保つため)。
 *
 * `dir` / `commitHash` は **右クリック時点で navigator が snapshot** して context に焼き付ける。
 * 後で worktree や commit 選択が切り替わっても、その右クリックで参照した当時の値を一貫して使う
 * (open 後に singleton store を読み直すと「古い relPath + 新 dir」の不整合 race が起きるため)。
 *
 * メニュー側は `joinAbsRel(dir, relPath)` で絶対 path に展開し、`commitHash === undefined` なら
 * 絶対 path のみ、定義されていれば `${hash}\n${絶対 path}` を clipboard に書く。
 *
 * x / y は contextmenu イベント時のマウス座標。指定時はメニュー側で `position: fixed; left/top`
 * を使い、undefined なら CSS Anchor Position で anchor 要素基準で出す (将来の menu 起動経路用)。
 *
 * NavigatorPane は `pointerup` capture listener を setup 直下に常設し、子 pane から bubble する
 * contextmenu event を `pending` ref に積んで次の pointerup で showPopover する。**`setTimeout(0)`
 * / `requestAnimationFrame` 等の defer は `popover="auto"` light-dismiss を
 * 抜けない** (whatwg/html#10905、WebKit shell 期に実機検証で確認)。続く mouseup が popover に到達して即 dismiss
 * されるため、`pointerup` が popover の show 前に消化されることで mouseup の dismiss 対象外に
 * 倒す。`{ capture: true }` を外したり pointerdown / mousedown 経路に変えてはならない。
 *
 * 副作用: keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火
 * しないため menu を開かない。本 PR の責務外で、将来 keyboard ショートカット要件が発生したら
 * keybinding システム ([docs/keybinding.md](../../../../docs/keybinding.md)) 経由で別途用意する。
 *
 * 開く直前に anchor 元 component が unmount された (dir 切替・`:key="dir"` 再マウント) ケースは
 * `anchorEl.isConnected` で検出し、debug log を残して open を skip する。
 *
 * 不変条件の重複: 上記 light-dismiss 不変条件 (defer 不可 / pointerup capture を変えない /
 * keyboard 経路は責務外) は `NavigatorPane.vue` の `useEventListener` 呼び出し直上の docstring
 * にも記載されている (実装変更時に直近で必ず読まれる位置に再掲することで回帰防止する設計)。
 * 仕様を変える際は両者を必ず同時に更新する責務がある。
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
  /**
   * 右クリック時点で filer が snapshot mode（`gitGraphStore.isSnapshotMode`）だったか。
   * Copy file の可視判定に使う。commitHash（Copy path の hash 前置き用）は range mode で
   * undefined になるため snapshot 判定には流用できない（判定の目的が別）。
   */
  isSnapshot: boolean;
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
