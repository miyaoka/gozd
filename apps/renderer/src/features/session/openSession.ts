import { activateDir, useTerminalStore } from "../terminal";

/**
 * セッション行を選択して「dir を active にし、session へ到達する」分岐の SSOT。
 * サイドバーとダッシュボードが共有する。
 *
 * - 端末が開いている: 該当 leaf を focus
 * - 端末が開いていない: `claude --resume` を仕込んで起動
 */
export function openSession(dir: string, sessionId: string): void {
  const terminalStore = useTerminalStore();
  const ptyId = terminalStore.getPtyIdBySessionId(sessionId);
  if (ptyId === undefined) {
    terminalStore.requestResumeSession(dir, sessionId);
    activateDir(dir);
    return;
  }
  activateDir(dir);
  terminalStore.focusPaneByPtyId(ptyId, dir);
}
