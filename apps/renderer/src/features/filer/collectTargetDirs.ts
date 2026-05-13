/**
 * `useFsWatchSync` が watch 対象 dir を計算する pure helper。
 *
 * 切り出してある理由: `useFsWatchSync.ts` は `shared/rpc/messages.ts` を
 * transitive に import し、それがモジュール ロード時に `window.__gozdReceive`
 * へ代入する。bun test 環境（非 DOM）では `window` が存在せず unit test を
 * import できない。`collectTargetDirs` は副作用ゼロの pure 関数なので、
 * これだけを独立 module に置いて test 可能にする。
 */
import type { useRepoStore } from "../../shared/repo";

/**
 * `collectTargetDirs` が読む `repoStore` の最小スコープ。Pinia store 全型を要求すると
 * test で stub を作る負担が大きいので、必要なフィールドだけを表現する型に絞る。
 * production 側は `useRepoStore()` の戻り値をそのまま渡せる（structural 互換）。
 */
export type RepoStoreForTargetDirs = Pick<ReturnType<typeof useRepoStore>, "dirOrder" | "repos">;

/**
 * `repoStore` の現在 state から watch すべき dir 集合を計算する pure helper。
 * - 各 repo の `isGitRepo` で分岐: git repo は配下の全 worktree path、非 git は rootDir 自身
 * - `dirOrder` 順は集合計算には影響しないが、reactive 依存収集のために `dirOrder` を読む
 */
export function collectTargetDirs(repoStore: RepoStoreForTargetDirs): Set<string> {
  const dirs = new Set<string>();
  for (const rootDir of repoStore.dirOrder) {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined) continue;
    if (!repo.isGitRepo) {
      dirs.add(repo.rootDir);
      continue;
    }
    for (const wt of repo.worktrees) {
      dirs.add(wt.path);
    }
  }
  return dirs;
}
