import type { Task } from "@gozd/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";

/**
 * viewMode を wt に倒し setOpen で selectedDir を切り替える選択プリミティブ。
 * dir を active にする全選択経路が共有する SSOT
 * (特定 caller を列挙するとドリフトの源になるため数えない)。
 * setOpen は冪等で、同一 dir の再選択でも selectionVersion が発火し
 * useTerminalStore 側の watch が done を消化する。
 */
export function selectDir(dir: string): void {
  const terminalStore = useTerminalStore();
  const worktreeStore = useWorktreeStore();
  terminalStore.viewMode = "wt";
  worktreeStore.setOpen(dir);
}

/**
 * task を選択して「dir を active にし、session へ到達する」分岐の SSOT。
 * サイドバー上段とダッシュボードが共有する。
 *
 * 分岐:
 * - task.sessionId 空 (PR/issue 由来で未起動 / SessionEnd で切り離し済み):
 *   新規に素の claude を起動する。SessionStart hook が attachSession で
 *   sessionId をこの task に結びつける (sessionId 空の最新 task を選択するため、
 *   同 wt に複数の未紐付け task があると最新が選ばれる仕様)。
 * - live PTY あり: 該当 leaf を focus
 * - resumable (sessionId あり、live PTY 無し): `claude --resume` を仕込んで起動
 */
export function openTaskSession(dir: string, task: Task): void {
  const terminalStore = useTerminalStore();
  if (task.sessionId === "") {
    terminalStore.requestNewClaudeSession(dir);
    selectDir(dir);
    return;
  }
  const ptyId = terminalStore.getPtyIdBySessionId(task.sessionId);
  if (ptyId === undefined) {
    terminalStore.requestResumeSession(dir, task.sessionId);
    selectDir(dir);
    return;
  }
  selectDir(dir);
  const leafId = terminalStore.getLeafIdByPtyId(ptyId);
  if (leafId === undefined) {
    // live PTY があるのに leaf が引けないのは paneRegistry の不整合。到達すると
    // 「クリックしたのに何も起きない」だけになり痕跡が残らないため観察ログを残す
    console.error(`[openTaskSession] no leaf for pty ptyId=${ptyId} dir=${dir}`);
    return;
  }
  terminalStore.focusPane(leafId);
}
