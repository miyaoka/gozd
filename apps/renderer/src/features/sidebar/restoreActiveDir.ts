import { useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";

/**
 * 前回終了時の active worktree（app-state.json の activeDir）を復元し、TerminalPane の
 * dir watch 経由でターミナルを自動で開く。hydrate 直後に 1 回だけ呼ぶ。復元しないケース:
 * - 既に選択済み（cold start の launch request 由来の gozdOpen が hydrate と並走して
 *   先に setOpen したケース）。明示 open を復元より優先する。逆順で gozdOpen が後着した
 *   場合も setOpen の後勝ちで明示 open が勝つため、到達順に依らず優先順位が保たれる
 * - 保存された dir がどの repo にも属さない（worktree キャッシュごと消えた / 手で
 *   編集された state）。外部削除で「キャッシュには居るが実体が無い」dir は
 *   updateRepoData の orphan fallback が rootDir へ倒すため、ここでは実在検証しない
 *   （その場合、復元が先に発火させる PTY spawn は削除済み dir で失敗しエラートーストが
 *   出るが、選択は fallback で自己回復する。稀なエッジとして受容する）
 */
export function restoreActiveDir(activeDir: string | undefined): void {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  if (activeDir === undefined || activeDir === "") return;
  if (worktreeStore.dir !== undefined) return;
  if (repoStore.findRepoOwning(activeDir) === undefined) return;
  worktreeStore.setOpen(activeDir);
}
