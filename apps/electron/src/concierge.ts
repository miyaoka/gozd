// 窓口（gozd の状態を読み、gozd を操作する Claude）に CLI で渡す操作の本体。
//
// 窓口は gozd が管理する専用のディレクトリで起動した Claude で、repo をまたいだ作業の
// 振り分け・セッションの検索と再開・worktree の片付けを行う（docs/concierge.md）。
// 削除のように取り消せない操作の条件は、窓口の判断に頼らずここで強制する。

import type { CliFailure, CliRepo, CliSession, SidebarRepo } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { listClaudeSessions } from "./claude/claudeSessionList";
import { worktreeList } from "./git/gitOps";
import { removeWorktree } from "./git/worktreeOps";
import { gozdDataRoot, resolveMainRepoRoot } from "./projectKey";

/** 窓口のディレクトリ。gozd が worktree を置く場所の隣に置く */
export function conciergeDir(): string {
  return join(gozdDataRoot(), "concierge");
}

/** パスの比較用。シンボリックリンク越しに渡されたパスも同じ実体なら一致させる */
function samePath(a: string, b: string): boolean {
  const realA = tryCatch(() => realpathSync(a));
  const realB = tryCatch(() => realpathSync(b));
  return (realA.ok ? realA.value : a) === (realB.ok ? realB.value : b);
}

/** gozd に登録された repo と、その worktree。
 * 読めない repo（ディスクから消えた等）は一覧から外して failures に載せる。1 つの壊れた登録で
 * 一覧全体を失わせず、欠けたことは窓口に伝えるため */
export async function listRegisteredRepos(
  sidebarRepos: SidebarRepo[],
): Promise<{ repos: CliRepo[]; failures: CliFailure[] }> {
  const repos: CliRepo[] = [];
  const failures: CliFailure[] = [];
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
      failures.push({ rootDir: repo.rootDir, error: String(listed.error) });
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
  return { repos, failures };
}

/** 登録済みの全 repo のセッションを最終更新の新しい順に返す。
 * 読めない repo は failures に載せる（`listRegisteredRepos` と同じ理由） */
export async function listRegisteredSessions(
  rootDirs: string[],
  liveSessionIds: ReadonlySet<string>,
): Promise<{ sessions: CliSession[]; failures: CliFailure[] }> {
  const sessions: Array<CliSession & { lastModifiedMs: number }> = [];
  const failures: CliFailure[] = [];
  for (const rootDir of rootDirs) {
    const listed = await tryCatch(listClaudeSessions(rootDir));
    if (!listed.ok) {
      console.error(
        `[listRegisteredSessions] session list failed, skipping ${rootDir}: ${listed.error}`,
      );
      failures.push({ rootDir, error: String(listed.error) });
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
  return {
    sessions: sessions
      .toSorted((a, b) => b.lastModifiedMs - a.lastModifiedMs)
      .map(({ lastModifiedMs: _lastModifiedMs, ...session }) => session),
    failures,
  };
}

/** gozd で開いている dir。登録済みの repo の worktree（非 git は root）と窓口 */
export function openDirsOf(repos: CliRepo[], concierge: string): Set<string> {
  const dirs = new Set<string>([concierge]);
  for (const repo of repos) {
    if (!repo.isGitRepo) dirs.add(repo.rootDir);
    for (const wt of repo.worktrees) dirs.add(wt.path);
  }
  return dirs;
}

/** セッションを開く dir を決める材料 */
export interface SessionOpenSources {
  /** Claude セッションが紐付いている端末 */
  liveSessions: ReadonlyArray<{ sessionId: string; worktreePath: string }>;
  /** セッションを起動した作業ディレクトリ（セッションログの記録）。見つからなければ undefined */
  cwd: string | undefined;
  /** gozd で開いている dir（`openDirsOf`） */
  openDirs: ReadonlySet<string>;
}

/**
 * セッションを開く dir を決める。開けなければ理由を投げる。
 *
 * 端末が開いているセッションは、その端末の dir で開く（サイドバーのクリックと同じ）。
 * 端末の開いていないセッションは作業ディレクトリで再開する。どちらも gozd で開いている dir で
 * なければ renderer が開けないため、指示を出さずに失敗を返す。
 * 返すのは一致した openDirs の要素そのもの。renderer はパスを文字列で照合するため、
 * シンボリックリンク越しに同じ実体を指す別表記を渡さない。
 */
export function resolveSessionOpenDir(sessionId: string, sources: SessionOpenSources): string {
  const live = sources.liveSessions.find((s) => s.sessionId === sessionId && s.worktreePath !== "");
  const dir = live?.worktreePath ?? sources.cwd;
  if (dir === undefined) throw new Error(`session not found: ${sessionId}`);
  const open = [...sources.openDirs].find((candidate) => samePath(candidate, dir));
  if (open === undefined) throw new Error(`'${dir}' is not open in gozd`);
  return open;
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
 * - 要求元が窓口の端末であること。要求元は端末の ID の申告で決まるため、これは誤操作の
 *   防止であって偽装は防がない（ソケットに書ける主体は元より git を直接実行できる）
 * - repo に登録された、main でない worktree であること。`removeWorktree` は git に判定させる
 *   前に実体を退避するため、worktree でないパスを渡さない
 * - ブランチを checkout していること。worktree を消してもブランチは残るが、detached HEAD の
 *   worktree はそこにしか無いコミットを指すことがあり、消すと到達不能になる
 * - 稼働中のセッションが無いこと（gozd の端末で Claude が紐付いている）
 * - 変更中のファイル（untracked を含む）と submodule が無く、lock されていないこと。強制しない
 *   削除として `removeWorktree`（git）が判定する
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
  if (target.branch === undefined) throw new Error(`'${path}' has a detached HEAD`);
  if (guards.liveWorktreePaths.some((live) => live !== "" && samePath(live, path))) {
    throw new Error(`'${path}' has a running Claude session`);
  }
  await removeWorktree(mainRoot, target.path, false);
}
