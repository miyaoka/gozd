import type { Task, WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState } from "../../shared/repo";
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

function wt(path: string, branch: string, tasks: Task[] = [], isMain = false): WorktreeEntry {
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

// createdAt の古い順に fixture へ並べ、新しい順 (降順) への並べ替えを検出できるようにする
const oldTask = task("old", "", "2026-07-25T00:00:01.000Z");
const newTask = task("new", "", "2026-07-25T00:00:02.000Z");
// createdAt は最古だが live status の lastActivityAt が最新 = 先頭に浮くべき
const liveTask = task("live", "sid-live", "2026-07-25T00:00:00.500Z");
const brokenTask = task("broken", "", "not-a-date");

const repos: Record<string, RepoState> = {
  "/repo-a": {
    rootDir: "/repo-a",
    repoName: "a",
    isGitRepo: true,
    githubIdentity: { owner: "octo", repo: "a" },
    worktrees: [wt("/repo-a", "main", [oldTask, liveTask, brokenTask], true)],
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

describe("collectDashboardRows", () => {
  test("live の lastActivityAt を先頭に、残りを createdAt 降順で並べる", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf);
    expect(rows.map((r) => r.task.id)).toEqual(["live", "new", "old", "broken"]);
  });

  test("createdAt が parse 不能な task は末尾に沈む", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf);
    expect(rows.at(-1)?.task.id).toBe("broken");
    expect(rows.at(-1)?.baseTime).toBeUndefined();
  });

  test("live status を持つ行は baseTime に lastActivityAt を採る", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf);
    expect(rows[0]?.baseTime).toBe(LIVE_AT);
  });

  test("worktree を持たない非 git project は行にならない", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf);
    expect(rows.some((r) => r.rootDir === "/note")).toBe(false);
  });

  test("poolDirs に載っているが repos から消えた rootDir は無視する", () => {
    expect(collectDashboardRows(["/ghost"], repos, statusOf)).toEqual([]);
  });

  test("行は repo 名・owner・branch ラベル・ジャンプ先 dir を持つ", () => {
    const rows = collectDashboardRows(POOL_DIRS, repos, statusOf);
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
