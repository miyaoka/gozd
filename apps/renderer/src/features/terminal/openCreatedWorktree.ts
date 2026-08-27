/**
 * 作成直後の worktree を UI に載せて開き、初期 leaf で claude を起動する。
 *
 * PR / issue picker（RPC で作る経路）と `gozd worktree new`（main が作って push する経路）が
 * 共有する後段。作成手段が違っても「開いた後どうなるか」は同じでなければならない。
 */
import type { CreateTaskWorktreeResponse } from "@gozd/rpc";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { activateDir } from "./activateDir";
import { useTerminalStore, type AutostartHint } from "./useTerminalStore";

export function openCreatedWorktree(
  created: CreateTaskWorktreeResponse,
  autostart: AutostartHint,
): void {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  const notify = useNotificationStore();

  // 掲載先は store が持つ repo のキーで指す。main が返す rootDir は realpath 解決済みの
  // main repo root で、store のキー（開いた時点の toplevel。worktree を直接開けば
  // worktree のパス）とは一致しないことがある。ずれたキーで append すると silent に
  // 落ち、サイドバーに出ない worktree でターミナルだけが動く
  const owning = repoStore.findRepoOwning(created.rootDir);
  if (owning === undefined) {
    notify.error("Worktree created but sidebar could not be updated");
    return;
  }
  repoStore.appendWorktree(owning.rootDir, created.worktree);
  // taskAdd 後の真値反映は requestRefresh に委ねる（楽観更新で renderer 側を直書きしない）
  repoStore.requestRefresh(owning.rootDir);
  // ヒントは activateDir より先に立てる。activateDir 起点の visit が初期 leaf を作るときに
  // 1 回だけ消費するため、後から立てても素のシェルが起動済みで claude は立たない
  terminalStore.requestNewClaudeSession(created.dir, autostart);
  terminalStore.setPreferredSetup(created.dir, created.setupScript);
  activateDir(created.dir);
}
