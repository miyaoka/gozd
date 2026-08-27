/**
 * 作成直後の worktree を UI に載せ、初期 leaf で claude を起動する。
 *
 * PR / issue picker（RPC で作る経路）と `gozd worktree new`（main が作って push する経路）が
 * 共有する後段。作成手段が違っても「開いた後どうなるか」は同じでなければならない。
 * 違うのは選択を動かすかどうかだけで、それは呼び出し元が reveal で宣言する。
 */
import type { CreateTaskWorktreeResponse } from "@gozd/rpc";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { activateDir } from "./activateDir";
import { useTerminalStore, type AutostartHint } from "./useTerminalStore";

/**
 * 作成した worktree を前面に出すかどうか。
 *
 * - `foreground`: 選択を切り替えて前面に出す。人の操作を起点にした作成が使う
 * - `background`: 選択を動かさない。エージェントを起点にした作成が使う
 *
 * 既定値を持たせない。呼び出し元の素性でしか決められない値で、取り違えるとユーザーの作業中に
 * 画面が切り替わる。
 */
export type WorktreeReveal = "foreground" | "background";

export function openCreatedWorktree(
  created: CreateTaskWorktreeResponse,
  autostart: AutostartHint,
  reveal: WorktreeReveal,
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
  // ヒントは visit より先に立てる。visit が初期 leaf を作るときに 1 回だけ消費するため、
  // 後から立てても素のシェルが起動済みで claude は立たない
  terminalStore.requestNewClaudeSession(created.dir, autostart);
  terminalStore.setPreferredSetup(created.dir, created.setupScript);
  // 端末の起動は reveal に依らずここが担う。選択の切り替えに任せると、選択を動かさない側で
  // 誰も visit を駆動せず claude が起動しない
  terminalStore.visit(created.dir);
  if (reveal === "foreground") activateDir(created.dir);
}
