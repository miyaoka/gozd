/**
 * git-graph の commit 行の右クリックメニュー (module singleton)。
 *
 * GitGraphPane が `open(anchorEl, { dir, hash, x, y })` を呼び、CommitContextMenu.vue が context を
 * 購読して描画する。menu アクションは「Reset (mixed) to here」1 個で、context の `hash` へ
 * `git reset --mixed` を実行する (`rpcGitResetMixed`)。
 *
 * `dir` / `hash` は **右クリック時点で GitGraphPane が snapshot** して context に焼き付ける。
 * 後で worktree 切替 / commit 選択 / git log 再取得が走っても、その右クリックで指した当時の
 * 値を一貫して使う (open 後に live store / commits を読み直すと「古い row + 新 dir」の不整合が
 * 起きるため)。Filer / Changes 版 (`useFileContextMenu`) と同じ snapshot semantics。
 *
 * x / y は contextmenu イベント時のマウス座標。指定時はメニュー側で `position: fixed; left/top`
 * を使い、undefined なら CSS Anchor Position で anchor 要素基準で出す。
 *
 * GitGraphPane は `pointerup` capture listener を setup 直下に常設し、commit 行から発火する
 * contextmenu を `pending` ref に積んで次の pointerup で showPopover する。**`setTimeout(0)` /
 * `requestAnimationFrame` 等の defer は WebKit (WebPage) の `popover="auto"` light-dismiss を
 * 抜けない** (whatwg/html#10905、実機検証で確認)。続く mouseup が popover に到達して即 dismiss
 * されるため、`pointerup` が popover の show 前に消化されることで mouseup の dismiss 対象外に
 * 倒す。`{ capture: true }` を外したり pointerdown / mousedown 経路に変えてはならない。macOS の
 * control+click は button=0 として dispatch される (webkit bugzilla 52174) ため、pointerup 側に
 * `event.button` filter を入れてはならない。`pointerdown` で pending を reset する経路も追加して
 * はならない: 右クリック sequence (pointerdown → contextmenu → pointerup) では右ボタン pointerdown
 * が pending 積みより前に終わるため単体では破綻しないが、pending が積まれた状態で別経路の
 * pointerdown (例: 左 click) が来ると pending を即消去し、次の pointerup での消化が起きなくなる。
 * 状態遷移を pointerup のみで完結させる現設計を維持する。
 *
 * 副作用: keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火
 * しないため menu を開かない。将来 keyboard ショートカット要件が出たら keybinding システム
 * ([docs/keybinding.md](../../../../docs/keybinding.md)) 経由で別途用意する。
 *
 * 不変条件の重複: 上記 light-dismiss 不変条件は `GitGraphPane.vue` の `useEventListener` 呼び出し
 * 直上の docstring にも再掲されている (実装変更時に直近で必ず読まれる位置に置くことで回帰防止)。
 * 仕様を変える際は両者を必ず同時に更新する。Filer / Changes 版の `useFileContextMenu.ts` とも
 * 同じ不変条件を共有するため、light-dismiss 周りの修正はそちらも合わせて確認する。
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
