import type { Task } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState, RepoWorktree } from "../../shared/repo";
import type { ClaudeStatus } from "../terminal";
import { collectDashboardRows } from "./collectDashboardRows";

function task(id: string, sessionId: string, createdAt = "2026-07-25T00:00:00.000Z"): Task {
  return {
    id,
    worktreeDir: "",
    userTitle: id,
    terminalTitle: "",
    ghTitle: "",
    sessionId,
    createdAt,
    closedByUser: false,
    ghRef: undefined,
  };
}

function wt(path: string, branch: string, tasks: Task[] = [], isMain = false): RepoWorktree {
  return {
    path,
    head: "",
    branch,
    isMain,
    gitStatuses: {},
    renameOldPaths: {},
    tasks,
    upstream: undefined,
    latestMtime: 0,
  };
}

const LIVE_AT = Date.parse("2026-07-25T12:00:00.000Z");
const WORKING: ClaudeStatus = { state: "working", lastActivityAt: LIVE_AT };

// 最終活動の古い順に fixture へ並べ、新しい順 (降順) への並べ替えを検出できるようにする。
// createdAt は最終活動と逆順にして、createdAt が並びに効いていないことを検出する
const oldTask = task("old", "sid-old", "2026-07-25T00:00:03.000Z");
const newTask = task("new", "sid-new", "2026-07-25T00:00:02.000Z");
const liveTask = task("live", "sid-live", "2026-07-25T00:00:01.000Z");
const notStartedTask = task("not-started", "", "2026-07-25T00:00:04.000Z");

const repos: Record<string, RepoState> = {
  "/repo-a": {
    rootDir: "/repo-a",
    repoName: "a",
    isGitRepo: true,
    githubIdentity: { owner: "octo", repo: "a" },
    worktrees: [wt("/repo-a", "main", [oldTask, liveTask, notStartedTask], true)],
  },
  "/repo-b": {
    rootDir: "/repo-b",
    repoName: "b",
    isGitRepo: true,
    worktrees: [wt("/repo-b/wt", "", [newTask])],
  },
  "/note": {
    rootDir: "/note",
    repoName: "note",
    isGitRepo: false,
    worktrees: [],
  },
};

const POOL_DIRS = ["/repo-a", "/repo-b", "/note"];

const statusOf = (sessionId: string): ClaudeStatus | undefined =>
  sessionId === "sid-live" ? WORKING : undefined;

const LOG_AT: Record<string, number> = {
  "sid-old": Date.parse("2026-07-25T01:00:00.000Z"),
  "sid-new": Date.parse("2026-07-25T02:00:00.000Z"),
};
const lastActivityOf = (sessionId: string): number | undefined => LOG_AT[sessionId];

describe("collectDashboardRows", () => {
  test("live の lastActivityAt を先頭に、残りをセッションログの最終活動の降順で並べる", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf, lastActivityOf);
    expect(rows.map((r) => r.task.id)).toEqual(["live", "new", "old", "not-started"]);
  });

  test("session 未起動の task は最終活動を持たず末尾に沈む", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf, lastActivityOf);
    expect(rows.at(-1)?.task.id).toBe("not-started");
    expect(rows.at(-1)?.baseTime).toBeUndefined();
  });

  test("live status を持つ行は baseTime に lastActivityAt を採る", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf, lastActivityOf);
    expect(rows[0]?.baseTime).toBe(LIVE_AT);
  });

  test("worktree を持たない非 git project は行にならない", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf, lastActivityOf);
    expect(rows.some((r) => r.rootDir === "/note")).toBe(false);
  });

  test("poolDirs に載っているが repos から消えた rootDir は無視する", () => {
    expect(collectDashboardRows(["/ghost"], repos, statusOf, lastActivityOf)).toEqual([]);
  });

  test("行は repo 名・owner・branch ラベル・ジャンプ先 dir を持つ", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf, lastActivityOf);
    const live = rows.find((r) => r.task.id === "live");
    expect(live?.repoName).toBe("a");
    expect(live?.owner).toBe("octo");
    expect(live?.dir).toBe("/repo-a");
    // detached HEAD (空 branch) はラベルに倒す
    const detached = rows.find((r) => r.task.id === "new");
    expect(detached?.branch).toBe("(detached)");
    expect(detached?.owner).toBeUndefined();
  });
});
