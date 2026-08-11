import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";

/**
 * viewMode を wt に倒し setOpen で selectedDir を切り替える選択プリミティブ。
 * wt ビューへ移動する dir 選択はこの関数を経由し、viewMode / setOpen の 2 行を直書きしない。
 * viewMode と選択のどちらか一方だけを動かす操作は別物で、ここは通さない
 * (viewMode 単独 = docs/terminal.md の「分割操作は意図を wt に戻す」、
 *  setOpen 単独 = docs/terminal.md の「横断ビューでの選択追従」と docs/workspace.md の
 *  アクティブセッションペイン)。
 * setOpen は冪等で、同一 dir の再選択でも selectionVersion が発火し
 * useTerminalStore 側の watch が done を消化する。
 */
export function activateDir(dir: string): void {
  const terminalStore = useTerminalStore();
  const worktreeStore = useWorktreeStore();
  terminalStore.viewMode = "wt";
  worktreeStore.setOpen(dir);
}
