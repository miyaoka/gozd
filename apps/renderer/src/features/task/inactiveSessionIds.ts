import type { RepoState } from "../../shared/repo";

/** repo プール全体の task のうち、session を持つがこのインスタンスで live でない sessionId */
export function collectInactiveSessionIds(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  isLive: (sessionId: string) => boolean,
): string[] {
  const ids = new Set<string>();
  for (const rootDir of poolDirs) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;
    for (const wt of repo.worktrees) {
      for (const task of wt.tasks) {
        if (task.sessionId === "" || isLive(task.sessionId)) continue;
        ids.add(task.sessionId);
      }
    }
  }
  return [...ids];
}

/** 前回の inactive 集合に無く、今回の集合にある sessionId（読み込み対象） */
export function enteredSessionIds(next: readonly string[], prev: readonly string[] = []): string[] {
  const prevSet = new Set(prev);
  return next.filter((id) => !prevSet.has(id));
}
