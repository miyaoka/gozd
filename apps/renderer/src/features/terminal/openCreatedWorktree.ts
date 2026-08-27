/**
 * 作成直後の worktree を UI に載せて開き、初期 leaf で claude を起動する。
 *
 * PR / issue picker（RPC で作る経路）と `gozd worktree new`（main が作って push する経路）が
 * 共有する後段。作成手段が違っても「開いた後どうなるか」は同じでなければならない。
 */
import type { CreateTaskWorktreeResponse } from "@gozd/rpc";
import { useRepoStore } from "../../shared/repo";
import { activateDir } from "./activateDir";
import { useTerminalStore } from "./useTerminalStore";

export function openCreatedWorktree(created: CreateTaskWorktreeResponse, prefill: string): void {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();

  repoStore.appendWorktree(created.rootDir, created.worktree);
  // taskAdd 後の真値反映は requestRefresh に委ねる（楽観更新で renderer 側を直書きしない）
  repoStore.requestRefresh(created.rootDir);
  // ヒントは activateDir より先に立てる。activateDir 起点の visit が初期 leaf を作るときに
  // 1 回だけ消費するため、後から立てても素のシェルが起動済みで claude は立たない
  terminalStore.requestNewClaudeSession(created.dir, prefill);
  terminalStore.setPreferredSetup(created.dir, created.setupScript);
  activateDir(created.dir);
}
