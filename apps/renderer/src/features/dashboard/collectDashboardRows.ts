import type { ClaudeSessionSummary } from "@gozd/rpc";
import type { RepoState } from "../../shared/repo";
import { branchLabel, repoDirEntries } from "../../shared/repo";
import { buildSessionRows, compareRecentFirst, type SessionRow } from "../session";
import type { LiveSession } from "../terminal";

/** ダッシュボード 1 行 = 1 セッション。行の描画とジャンプに必要な値だけを持つ */
export interface DashboardRow extends SessionRow {
  /** repo list の追従 (activateRepoListContaining / expand) に使う */
  rootDir: string;
  repoName: string;
  /** GitHub owner。undefined は解決中、空文字は owner なし (RepoIcon の 3 値契約) */
  owner: string | undefined;
  /** worktree のブランチ表示。非 git project は空文字 */
  branch: string;
}

/**
 * 全 repo 横断のセッションを最終活動の新しい順に平坦化する純関数。
 *
 * 母集団は poolDirs (repo プール全体)。アクティブ repo list で絞ると「動いているのに
 * 一覧に出ない」セッションが生まれる。
 *
 * サイドバーは worktree ごとに端末の開いているセッションを上に分けるが、ここは開くたびに
 * 使い捨てる transient な一覧なので、端末の有無で分けず「最近動いた = 注意対象」を上に置く。
 *
 * 作業ディレクトリが現存する worktree / 非 git project のセッションだけを行にする。
 * 削除済み worktree のセッションは revive picker が扱う。
 */
export function collectDashboardRows(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  sessionsOf: (rootDir: string) => readonly ClaudeSessionSummary[],
  liveSessions: readonly LiveSession[],
): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const rootDir of poolDirs) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;
    const listed = sessionsOf(rootDir);

    for (const { dir, worktree } of repoDirEntries(repo)) {
      const { live, inactive } = buildSessionRows(dir, liveSessions, listed);
      for (const row of [...live, ...inactive]) {
        rows.push({
          ...row,
          rootDir,
          repoName: repo.repoName,
          owner: repo.githubIdentity?.owner,
          branch: worktree === undefined ? "" : branchLabel(worktree.branch),
        });
      }
    }
  }
  return rows.toSorted(compareRecentFirst);
}
