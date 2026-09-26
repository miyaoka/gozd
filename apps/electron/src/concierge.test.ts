// 窓口の操作のテスト。削除の安全は git の判定そのものが対象なので、実 repo と実 worktree を
// 作って検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConciergeRemoveGuards,
  listRegisteredRepos,
  openDirsOf,
  removeWorktreeForConcierge,
  resolveSessionOpenDir,
} from "./concierge";
import { runFixtureGit } from "./testGitFixture";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 初期 commit 1 個の repo と、そこから生やした worktree 1 個。窓口のディレクトリも並べて作る */
function makeFixture(): { repo: string; wt: string; concierge: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), "gozd-concierge-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  runFixtureGit(["init", "-b", "main"], repo);
  runFixtureGit(["config", "user.email", "t@example.com"], repo);
  runFixtureGit(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  runFixtureGit(["add", "."], repo);
  runFixtureGit(["commit", "-m", "first"], repo);
  const wt = join(root, "wt");
  runFixtureGit(["worktree", "add", "-b", "feature", wt], repo);
  const concierge = join(root, "concierge");
  mkdirSync(concierge);
  const other = join(root, "other");
  mkdirSync(other);
  return { repo, wt, concierge, other };
}

function guards(concierge: string, overrides: Partial<ConciergeRemoveGuards> = {}) {
  return { conciergeDir: concierge, requesterDir: concierge, liveWorktreePaths: [], ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const result = await tryCatch(promise);
  if (result.ok) throw new Error("expected rejection but resolved");
  return result.error;
}

describe("removeWorktreeForConcierge", () => {
  test("窓口から要求された clean な worktree は削除される", async () => {
    const { wt, concierge } = makeFixture();
    await removeWorktreeForConcierge(wt, guards(concierge));
    expect(existsSync(wt)).toBe(false);
  });

  test("窓口以外の端末からの要求は拒否し、worktree は残る", async () => {
    const { wt, concierge, other } = makeFixture();
    const error = await rejection(
      removeWorktreeForConcierge(wt, guards(concierge, { requesterDir: other })),
    );
    expect(error.message).toContain("concierge");
    expect(existsSync(wt)).toBe(true);
  });

  test("gozd の端末の外（要求元が未登録）からの要求は拒否する", async () => {
    const { wt, concierge } = makeFixture();
    await rejection(removeWorktreeForConcierge(wt, guards(concierge, { requesterDir: "" })));
    expect(existsSync(wt)).toBe(true);
  });

  test("変更中のファイルがある worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    writeFileSync(join(wt, "a.txt"), "changed\n");
    const error = await rejection(removeWorktreeForConcierge(wt, guards(concierge)));
    expect(error.message).toContain("modified or untracked");
    expect(existsSync(wt)).toBe(true);
  });

  test("untracked のファイルがある worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    writeFileSync(join(wt, "new.txt"), "new\n");
    await rejection(removeWorktreeForConcierge(wt, guards(concierge)));
    expect(existsSync(join(wt, "new.txt"))).toBe(true);
  });

  test("稼働中のセッションがある worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    const error = await rejection(
      removeWorktreeForConcierge(wt, guards(concierge, { liveWorktreePaths: [wt] })),
    );
    expect(error.message).toContain("running Claude session");
    expect(existsSync(wt)).toBe(true);
  });

  test("main worktree は拒否し、残る", async () => {
    const { repo, concierge } = makeFixture();
    const error = await rejection(removeWorktreeForConcierge(repo, guards(concierge)));
    expect(error.message).toContain("main worktree");
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
  });

  test("detached HEAD の worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    runFixtureGit(["checkout", "--detach"], wt);
    const error = await rejection(removeWorktreeForConcierge(wt, guards(concierge)));
    expect(error.message).toContain("detached HEAD");
    expect(existsSync(wt)).toBe(true);
  });

  test("worktree でないパスは拒否し、実体に触れない", async () => {
    const { repo, concierge } = makeFixture();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const error = await rejection(removeWorktreeForConcierge(sub, guards(concierge)));
    expect(error.message).toContain("not a worktree");
    expect(existsSync(sub)).toBe(true);
  });
});

describe("listRegisteredRepos", () => {
  test("git repo は worktree 付きで、非 git project は worktree 無しで返す", async () => {
    const { repo, wt, other } = makeFixture();
    const { repos, failures } = await listRegisteredRepos([
      { rootDir: repo, repoName: "repo", isGitRepo: true, collapsed: false, worktrees: [] },
      { rootDir: other, repoName: "other", isGitRepo: false, collapsed: false, worktrees: [] },
    ]);
    expect(failures).toEqual([]);
    expect(repos.map((r) => r.name)).toEqual(["repo", "other"]);
    const [gitRepo, plain] = repos;
    expect(gitRepo?.worktrees.map((w) => ({ branch: w.branch, isMain: w.isMain }))).toEqual([
      { branch: "main", isMain: true },
      { branch: "feature", isMain: false },
    ]);
    // tmpdir は /var → /private/var のシンボリックリンク越しなので実体で比べる
    expect(realpathSync(gitRepo?.worktrees[1]?.path ?? "")).toBe(realpathSync(wt));
    expect(plain?.worktrees).toEqual([]);
  });

  test("ディスクから消えた repo は一覧から外し、failures に載せる", async () => {
    const { repo } = makeFixture();
    const gone = join(repo, "gone");
    const { repos, failures } = await listRegisteredRepos([
      { rootDir: gone, repoName: "gone", isGitRepo: true, collapsed: false, worktrees: [] },
      { rootDir: repo, repoName: "repo", isGitRepo: true, collapsed: false, worktrees: [] },
    ]);
    expect(repos.map((r) => r.name)).toEqual(["repo"]);
    expect(failures.map((f) => f.rootDir)).toEqual([gone]);
  });
});

describe("resolveSessionOpenDir", () => {
  const openDirs = new Set(["/repo", "/repo/wt"]);

  test("端末が開いているセッションは、その端末の dir で開く", () => {
    const dir = resolveSessionOpenDir("s1", {
      liveSessions: [{ sessionId: "s1", worktreePath: "/repo/wt" }],
      cwd: "/repo/wt/sub",
      openDirs,
    });
    expect(dir).toBe("/repo/wt");
  });

  test("端末の開いていないセッションは作業ディレクトリで開く", () => {
    const dir = resolveSessionOpenDir("s1", { liveSessions: [], cwd: "/repo/wt", openDirs });
    expect(dir).toBe("/repo/wt");
  });

  test("gozd で開いていない dir のセッションは開けない", () => {
    expect(() =>
      resolveSessionOpenDir("s1", { liveSessions: [], cwd: "/elsewhere", openDirs }),
    ).toThrow("not open in gozd");
  });

  test("見つからないセッションは開けない", () => {
    expect(() =>
      resolveSessionOpenDir("s1", { liveSessions: [], cwd: undefined, openDirs }),
    ).toThrow("session not found");
  });
});

describe("openDirsOf", () => {
  test("git repo は worktree、非 git project は root、それに窓口を含む", () => {
    const dirs = openDirsOf(
      [
        {
          rootDir: "/repo",
          name: "repo",
          isGitRepo: true,
          worktrees: [
            { path: "/repo", branch: "main", isMain: true },
            { path: "/repo/wt", branch: "feature", isMain: false },
          ],
        },
        { rootDir: "/note", name: "note", isGitRepo: false, worktrees: [] },
      ],
      "/concierge",
    );
    expect([...dirs].toSorted()).toEqual(["/concierge", "/note", "/repo", "/repo/wt"]);
  });
});
