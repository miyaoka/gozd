import type { Task } from "@gozd/rpc";
import type { RepoState } from "../../shared/repo";
import { repoDirEntries, taskDisplayTitle } from "../../shared/repo";
import { branchLabel, resolveTaskBaseTime } from "../sidebar";
import type { ClaudeStatus } from "../terminal";

/** ダッシュボード 1 行 = 1 task。行の描画とジャンプに必要な値だけを持つ */
export interface DashboardRow {
  /** repo list の追従 (activateRepoListContaining / expand) に使う */
  rootDir: string;
  /** ジャンプ先の dir (worktree path) */
  dir: string;
  task: Task;
  status: ClaudeStatus | undefined;
  repoName: string;
  /** GitHub owner。undefined は解決中、空文字は owner なし (RepoIcon の 3 値契約) */
  owner: string | undefined;
  branch: string;
  title: string;
  /** 並び順と相対時刻の基準 (最終活動 or createdAt)。ms epoch */
  baseTime: number | undefined;
}

/**
 * 全 repo 横断の task を最終活動の新しい順に平坦化する純関数。
 *
 * 母集団は poolDirs (repo プール全体)。アクティブ repo list で絞ると「動いているのに
 * 一覧に出ない」task が生まれる (collectActiveSessionGroups と同じ理由)。
 *
 * 並びはサイドバーの compareTaskOrder (createdAt 固定順) とあえて違う動的順にする。
 * サイドバーは常設面で空間記憶に最適化するが、ここは開くたびに使い捨てる transient な
 * 一覧なので空間記憶が成立せず、「最近動いた = 注意対象」を上に置くほうが目的に合う。
 *
 * task は worktree にのみ紐づくため、非 git project (worktree を持たない) は対象外。
 */
export function collectDashboardRows(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  statusOf: (sessionId: string) => ClaudeStatus | undefined,
): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const rootDir of poolDirs) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;

    for (const { dir, worktree } of repoDirEntries(repo)) {
      if (worktree === undefined) continue;
      for (const task of worktree.tasks) {
        const status = task.sessionId === "" ? undefined : statusOf(task.sessionId);
        rows.push({
          rootDir,
          dir,
          task,
          status,
          repoName: repo.repoName,
          owner: repo.githubIdentity?.owner,
          branch: branchLabel(worktree.branch),
          title: taskDisplayTitle(task),
          baseTime: resolveTaskBaseTime(status, task),
        });
      }
    }
  }
  // baseTime 不明 (createdAt 破損) は 0 扱いで末尾に沈める
  rows.sort((a, b) => (b.baseTime ?? 0) - (a.baseTime ?? 0));
  return rows;
}
