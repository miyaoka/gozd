/**
 * commit 行の右クリックメニューを開くトリガー。呼び出し側は右クリック時に
 * `requestOpen(anchorEl, { dir, hash, x, y })` を呼ぶだけでよい。実際の popover 表示は次の
 * pointerup まで遅延させる (WebKit light-dismiss 回避)。この遅延と回避策はこの composable が
 * 内包し、context-menu 機能を自己完結させる。
 *
 * **不変条件 (実装変更時に必読)**:
 * - `setTimeout(0)` / `requestAnimationFrame` / `queueMicrotask` 等の defer は
 *   `popover="auto"` light-dismiss を **抜けない** (WebKit shell 期に実機検証済)。続く mouseup が
 *   popover に到達して即 dismiss される (whatwg/html#10905)
 * - `pointerup` を `capture: true` で window に貼ると、popover が show される **前** に listener が
 *   pointerup を消化する → 続く mouseup は popover open 前の press cycle として扱われ light-dismiss の
 *   対象外になる。`{ capture: true }` を外したり pointerdown / mousedown 経路に変えてはならない
 * - `event.button` filter を入れてはならない。macOS WebKit は control+click を button=0 として
 *   dispatch する (webkit bugzilla 52174) ため、control+click 経由で menu が開かなくなる。
 *   pending そのものが「直前に contextmenu があった」flag を兼ねる
 * - `pointerdown` で pending を reset する経路を追加してはならない。状態遷移を pointerup のみで完結させる
 * - keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火しないため
 *   menu は開かない (本対応の責務外)
 *
 * `useEventListener` を setup 直下で呼ぶことで effect scope に紐付き、unmount / HMR で自動 cleanup
 * される。`dir` / `hash` は requestOpen 呼び出し時点で呼び出し側が snapshot して渡す (pointerup 待機中に
 * worktree 切替 / commit 選択切替 / git log 再取得が起きても、その右クリック時点の値を保持する)。
 */
import { useEventListener } from "@vueuse/core";
import { ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useCommitContextMenu } from "./useCommitContextMenu";

/** requestOpen 呼び出し時に snapshot するメニュー文脈 */
export type CommitContextMenuArgs = {
  /** 右クリック時の worktree dir (絶対パス) */
  dir: string;
  /** 右クリックした commit の hash (full)。working tree 行はメニュー対象外なので必ず実 commit */
  hash: string;
  /** contextmenu イベント時のマウス座標 */
  x: number;
  y: number;
};

type Pending = CommitContextMenuArgs & { anchorEl: HTMLElement };

export function useCommitContextMenuTrigger() {
  const { open } = useCommitContextMenu();
  const notify = useNotificationStore();

  /**
   * 右クリックで積まれる、次の pointerup で開くべきメニュー。連打時は最後の右クリックが上書きする
   * (popover singleton の openState 上書き semantics と整合)。
   */
  const pending = ref<Pending | null>(null);

  useEventListener(
    window,
    "pointerup",
    () => {
      const p = pending.value;
      if (!p) return;
      pending.value = null;
      if (!p.anchorEl.isConnected) {
        notify.debug("[CommitContextMenu] anchor disconnected before open, skipping", {
          hash: p.hash,
        });
        return;
      }
      open(p.anchorEl, { dir: p.dir, hash: p.hash, x: p.x, y: p.y });
    },
    { capture: true },
  );

  /** 右クリック時に呼ぶ。anchorEl / 文脈は呼び出し側が同期的に snapshot して渡す。 */
  function requestOpen(anchorEl: HTMLElement, args: CommitContextMenuArgs) {
    pending.value = { anchorEl, ...args };
  }

  return { requestOpen };
}
