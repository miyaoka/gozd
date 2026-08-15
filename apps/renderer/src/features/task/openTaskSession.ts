import type { Task } from "@gozd/rpc";
import { activateDir, useTerminalStore } from "../terminal";

/**
 * task を選択して「dir を active にし、session へ到達する」分岐の SSOT。
 * サイドバーとダッシュボードが共有する。
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
    activateDir(dir);
    return;
  }
  const ptyId = terminalStore.getPtyIdBySessionId(task.sessionId);
  if (ptyId === undefined) {
    terminalStore.requestResumeSession(dir, task.sessionId);
    activateDir(dir);
    return;
  }
  activateDir(dir);
  terminalStore.focusPaneByPtyId(ptyId, dir);
}
