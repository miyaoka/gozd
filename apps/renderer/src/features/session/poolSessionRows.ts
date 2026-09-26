import type { ClaudeSessionSummary } from "@gozd/rpc";
import type { RepoState } from "../../shared/repo";
import { branchLabel, repoDirEntries } from "../../shared/repo";
import type { LiveSession } from "../terminal";
import { buildSessionRows, compareRecentFirst, type SessionRow } from "./sessionRows";

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
  for (const { rootDir, repo, dir, worktree } of poolDirEntries(poolDirs, repos)) {
    const { live, inactive } = buildSessionRows(dir, liveSessions, sessionsOf(rootDir));
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
  return rows.toSorted(compareRecentFirst);
}

/**
 * 端末が開いているセッションを持つプールの repo の rootDir（重複あり）。
 * `collectPoolSessionRows` の live 行と同じ範囲・同じ一致規則で求めるが、ログ由来の一覧は
 * 読まない。hook イベントや端末タイトルの更新のたびに評価される経路で、プール全体の行を
 * 組み立てずに済ませるため。
 */
export function collectLivePoolRootDirs(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  liveSessions: readonly LiveSession[],
): string[] {
  const liveDirs = new Set(liveSessions.map((session) => session.dir));
  const rootDirs: string[] = [];
  for (const { rootDir, dir } of poolDirEntries(poolDirs, repos)) {
    if (liveDirs.has(dir)) rootDirs.push(rootDir);
  }
  return rootDirs;
}

/** プールの repo の作業ディレクトリを列挙する。セッション行を作る範囲の SSOT */
function* poolDirEntries(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
): Generator<{ rootDir: string; repo: RepoState } & ReturnType<typeof repoDirEntries>[number]> {
  for (const rootDir of poolDirs) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;
    for (const entry of repoDirEntries(repo)) yield { rootDir, repo, ...entry };
  }
}
