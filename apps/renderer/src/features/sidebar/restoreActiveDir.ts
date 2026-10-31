import { activeWorktreeRemovedMessage, useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";

/** git の一覧で確かめてから開く、前回終了時の active worktree */
export interface PendingActiveDir {
  /** 一覧を待つ repo */
  rootDir: string;
  dir: string;
}

/**
 * 前回終了時の active worktree（app-state.json の activeDir）を復元し、TerminalPane の
 * dir watch 経由でターミナルを自動で開く。hydrate 直後に 1 回だけ呼ぶ。
 *
 * キャッシュから復元しただけの worktree は、前回の終了後に消えていることがある。開くと
 * 消えた dir でターミナルの起動が失敗するため、すぐには開かず、所属 repo の git の一覧を
 * 待つ対象として返す。一覧が届いたら `settleActiveDir` で開く先を決める。
 * キャッシュに無い dir（非 git project、窓口、hydrate 前に一覧を取得済みの worktree）は
 * すぐに開く。
 *
 * 復元しないケース:
 * - 既に選択済み（cold start の launch request 由来の gozdOpen が hydrate と並走して
 *   先に setOpen したケース）。明示 open を復元より優先する。逆順で gozdOpen が後着した
 *   場合も setOpen の後勝ちで明示 open が勝つため、到達順に依らず優先順位が保たれる
 * - 保存された dir がどの repo にも属さない（worktree キャッシュごと消えた / 手で
 *   編集された state）
 */
export function restoreActiveDir(activeDir: string | undefined): PendingActiveDir | undefined {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  if (activeDir === undefined || activeDir === "") return undefined;
  if (worktreeStore.dir !== undefined) return undefined;
  const owning = repoStore.findRepoOwning(activeDir);
  if (owning === undefined) return undefined;
  const worktree = owning.worktrees.find((wt) => wt.path === activeDir);
  if (worktree?.cached === true) return { rootDir: owning.rootDir, dir: activeDir };
  worktreeStore.setOpen(activeDir);
  return undefined;
}

/**
 * `pending.rootDir` の git の一覧を反映した直後に呼ぶ。前回の worktree が一覧に載っていれば
 * 開き、載っていなければ repo の root を開いて `notify` で知らせる。
 * 一覧を待つ間に別の dir が開かれていたら、その明示 open を優先して何もしない。
 */
export function settleActiveDir(
  pending: PendingActiveDir,
  notify: (message: string) => void,
): void {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  if (worktreeStore.dir !== undefined) return;
  const repo = repoStore.repoAt(pending.rootDir);
  if (repo === undefined) return;
  if (repo.worktrees.some((wt) => wt.path === pending.dir)) {
    worktreeStore.setOpen(pending.dir);
    return;
  }
  worktreeStore.setOpen(pending.rootDir);
  notify(activeWorktreeRemovedMessage(repo));
}
