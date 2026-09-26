// 窓口（gozd の状態を読み、gozd を操作する Claude）に CLI で渡す操作の本体。
//
// 窓口は gozd が管理する専用のディレクトリで起動した Claude で、repo をまたいだ作業の
// 振り分け・セッションの検索と再開・worktree の片付けを行う（docs/concierge.md）。
// 削除のように取り消せない操作の安全は、窓口の判断に頼らずここで強制する。

import type { CliRepo, CliSession, SidebarRepo } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listClaudeSessions } from "./claude/claudeSessionList";
import { worktreeList } from "./git/gitOps";
import { removeWorktree } from "./git/worktreeOps";
import { resolveMainRepoRoot } from "./projectKey";

/** 窓口のディレクトリ。gozd が worktree を置く場所の隣に置く */
export function conciergeDir(): string {
  return join(homedir(), ".local", "share", "gozd", "concierge");
}

/** パスの比較用。シンボリックリンク越しに渡されたパスも同じ実体なら一致させる */
function samePath(a: string, b: string): boolean {
  const realA = tryCatch(() => realpathSync(a));
  const realB = tryCatch(() => realpathSync(b));
  return (realA.ok ? realA.value : a) === (realB.ok ? realB.value : b);
}

/** gozd に登録された repo と、その worktree。
 * 読めない repo（ディスクから消えた等）はログを残して一覧から外す。1 つの壊れた登録で
 * 一覧全体を失わせないため */
export async function listRegisteredRepos(sidebarRepos: SidebarRepo[]): Promise<CliRepo[]> {
  const repos: CliRepo[] = [];
  for (const repo of sidebarRepos) {
    if (!repo.isGitRepo) {
      repos.push({ rootDir: repo.rootDir, name: repo.repoName, isGitRepo: false, worktrees: [] });
      continue;
    }
    const listed = await tryCatch(worktreeList(repo.rootDir));
    if (!listed.ok) {
      console.error(
        `[listRegisteredRepos] worktree list failed, skipping ${repo.rootDir}: ${listed.error}`,
      );
      continue;
    }
    repos.push({
      rootDir: repo.rootDir,
      name: repo.repoName,
      isGitRepo: true,
      worktrees: listed.value.map((wt) => ({
        path: wt.path,
        branch: wt.branch ?? "",
        isMain: wt.isMain,
      })),
    });
  }
  return repos;
}

/** 登録済みの全 repo のセッションを最終更新の新しい順に返す。
 * 読めない repo はログを残して外す（`listRegisteredRepos` と同じ理由） */
export async function listRegisteredSessions(
  rootDirs: string[],
  liveSessionIds: ReadonlySet<string>,
): Promise<CliSession[]> {
  const sessions: Array<CliSession & { lastModifiedMs: number }> = [];
  for (const rootDir of rootDirs) {
    const listed = await tryCatch(listClaudeSessions(rootDir));
    if (!listed.ok) {
      console.error(
        `[listRegisteredSessions] session list failed, skipping ${rootDir}: ${listed.error}`,
      );
      continue;
    }
    for (const s of listed.value) {
      sessions.push({
        sessionId: s.sessionId,
        cwd: s.cwd,
        rootDir,
        title: s.title,
        lastModified: new Date(s.lastModified).toISOString(),
        lastModifiedMs: s.lastModified,
        live: liveSessionIds.has(s.sessionId),
      });
    }
  }
  return sessions
    .toSorted((a, b) => b.lastModifiedMs - a.lastModifiedMs)
    .map(({ lastModifiedMs: _lastModifiedMs, ...session }) => session);
}

/** 窓口からの worktree 削除で守る条件 */
export interface ConciergeRemoveGuards {
  /** 窓口のディレクトリ */
  conciergeDir: string;
  /** 要求元の端末を開いたディレクトリ。未登録の端末は空文字 */
  requesterDir: string;
  /** Claude セッションが紐付いている端末の worktree */
  liveWorktreePaths: readonly string[];
}

/**
 * 窓口からの要求で worktree を削除する。守れない条件があれば削除せず理由を投げる。
 *
 * - 要求元が窓口の端末であること
 * - repo に登録された、main でない worktree であること。`removeWorktree` は git に判定させる
 *   前に実体を退避するため、worktree でないパスを渡さない
 * - 稼働中のセッションが無いこと（gozd の端末で Claude が紐付いている）
 * - 変更中のファイル（untracked を含む）と submodule が無いこと。強制しない削除として
 *   `removeWorktree` が判定する
 *
 * Claude の動いていない端末は削除を妨げない。削除後に renderer が worktree の消滅を検知して
 * その端末を閉じる。
 */
export async function removeWorktreeForConcierge(
  path: string,
  guards: ConciergeRemoveGuards,
): Promise<void> {
  if (guards.requesterDir === "" || !samePath(guards.requesterDir, guards.conciergeDir)) {
    throw new Error("worktree remove is accepted only from the concierge terminal");
  }
  const mainRoot = await resolveMainRepoRoot(path);
  const registered = await tryCatch(worktreeList(mainRoot));
  if (!registered.ok) throw new Error(`'${path}' is not in a git repository`);
  const target = registered.value.find((wt) => samePath(wt.path, path));
  if (target === undefined) throw new Error(`'${path}' is not a worktree`);
  if (target.isMain) throw new Error(`'${path}' is the main worktree`);
  if (guards.liveWorktreePaths.some((live) => live !== "" && samePath(live, path))) {
    throw new Error(`'${path}' has a running Claude session`);
  }
  await removeWorktree(mainRoot, target.path, false);
}
