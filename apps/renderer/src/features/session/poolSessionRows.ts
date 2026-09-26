import type { ClaudeSessionSummary } from "@gozd/rpc";
import type { RepoState } from "../../shared/repo";
import { branchLabel, repoDirEntries } from "../../shared/repo";
import { buildSessionRows, compareRecentFirst, type SessionRow } from "./sessionRows";
import type { LiveSession } from "../terminal";

/** repo をまたいだ一覧の 1 行 = 1 セッション。どの repo / worktree の行かを添える */
export interface PoolSessionRow extends SessionRow {
  /** repo list の追従 (activateRepoListContaining / expand) に使う */
  rootDir: string;
  repoName: string;
  /** GitHub owner。undefined は解決中、空文字は owner なし (RepoIcon の 3 値契約) */
  owner: string | undefined;
  /** worktree のブランチ表示。非 git project は空文字 */
  branch: string;
}

/**
 * 全 repo 横断のセッションを最終活動の新しい順に平坦化する純関数。ダッシュボードと
 * サイドバーの状態別の一覧が使う。
 *
 * 母集団は poolDirs (repo プール全体)。アクティブ repo list で絞ると「動いているのに
 * 一覧に出ない」セッションが生まれる。端末の有無では分けない。
 *
 * 作業ディレクトリが現存する worktree / 非 git project のセッションだけを行にする。
 * 削除済み worktree のセッションは revive picker が扱う。
 */
export function collectPoolSessionRows(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  sessionsOf: (rootDir: string) => readonly ClaudeSessionSummary[],
  liveSessions: readonly LiveSession[],
): PoolSessionRow[] {
  const rows: PoolSessionRow[] = [];
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
