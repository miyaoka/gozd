import { activeWorktreeRemovedMessage, useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";

/**
 * 前回終了時の active worktree（app-state.json の activeDir）を復元し、TerminalPane の
 * dir watch 経由でターミナルを自動で開く。hydrate 直後に 1 回だけ呼ぶ。
 *
 * キャッシュから復元しただけの worktree（`cached`）は、前回の終了後に消えていることがある。
 * 開くと消えた dir でターミナルの起動が失敗するため、すぐには開かず repoStore の
 * `pendingActiveDir` に置いて、所属 repo の git の一覧を待つ。一覧が届いたら
 * `settleActiveDir` が開く先を決め、取得に失敗したら `openActiveDirUnverified` がそのまま開く。git の一覧で確かめ済みの dir と、worktree を持たない
 * dir（非 git project、窓口）はすぐに開く。
 *
 * 復元しないケース:
 * - 既に選択済み（cold start の launch request 由来の gozdOpen が hydrate と並走して
 *   先に setOpen したケース）。明示 open を復元より優先する。逆順で gozdOpen が後着した
 *   場合も setOpen の後勝ちで明示 open が勝つため、到達順に依らず優先順位が保たれる
 * - 保存された dir がどの repo にも属さない（worktree キャッシュごと消えた / 手で
 *   編集された state）
 */
export function restoreActiveDir(activeDir: string | undefined): void {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  if (activeDir === undefined || activeDir === "") return;
  if (worktreeStore.dir !== undefined) return;
  const owning = repoStore.findRepoOwning(activeDir);
  if (owning === undefined) return;
  const worktree = owning.worktrees.find((wt) => wt.path === activeDir);
  if (worktree?.cached === true) {
    repoStore.setPendingActiveDir({ rootDir: owning.rootDir, dir: activeDir });
    return;
  }
  worktreeStore.setOpen(activeDir);
}

/**
 * repo の git の一覧を反映した後に呼ぶ。`pendingActiveDir` の repo の一覧がすべて確かめ済みに
 * なっていれば、前回の worktree が載っていれば開き、載っていなければ repo の root を開いて
 * `notify` で知らせる。一覧がまだ届いていなければ何もせず待ち続ける。
 * 待つ間に何かが選択されると `pendingActiveDir` は消えるため、明示 open が優先される。
 */
export function settleActiveDir(notify: (message: string) => void): void {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const pending = repoStore.pendingActiveDir;
  if (pending === undefined) return;
  const repo = repoStore.repoAt(pending.rootDir);
  if (repo === undefined) return;
  if (repo.worktrees.some((wt) => wt.cached === true)) return;
  if (repo.worktrees.some((wt) => wt.path === pending.dir)) {
    worktreeStore.setOpen(pending.dir);
    return;
  }
  worktreeStore.setOpen(pending.rootDir);
  notify(activeWorktreeRemovedMessage(repo));
}

/**
 * repo の git の一覧の取得に失敗した後に呼ぶ。`pendingActiveDir` がその repo のものなら、
 * 確かめないまま前回の worktree を開く。取得の失敗は消えたことの証明にならないため、
 * キャッシュを信じて開き、実際に消えていればターミナルの起動の失敗として見せる。
 */
export function openActiveDirUnverified(rootDir: string): void {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const pending = repoStore.pendingActiveDir;
  if (pending === undefined || pending.rootDir !== rootDir) return;
  worktreeStore.setOpen(pending.dir);
}
