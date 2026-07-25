import type { Task, WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState } from "../../shared/repo";
import type { ClaudeStatus } from "../terminal";
import { collectActiveSessionGroups } from "./activeSessions";

function task(id: string, sessionId: string): Task {
  return {
    id,
    worktreeDir: "",
    userTitle: id,
    terminalTitle: "",
    ghTitle: "",
    sessionId,
    createdAt: "2026-07-25T00:00:00.000Z",
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

const WORKING: ClaudeStatus = { state: "working", lastActivityAt: 0 };

const liveTask = task("live", "sid-live");
const deadTask = task("dead", "sid-dead");
const notStartedTask = task("not-started", "");

const repos: Record<string, RepoState> = {
  "/repo-a": {
    rootDir: "/repo-a",
    repoName: "a",
    isGitRepo: true,
    worktrees: [
      wt("/repo-a", "main", [], true),
      wt("/repo-a/wt", "feat", [liveTask, deadTask, notStartedTask]),
    ],
  },
  "/note": {
    rootDir: "/note",
    repoName: "note",
    isGitRepo: false,
    worktrees: [],
  },
};

const POOL_DIRS = ["/repo-a", "/note"];

/** sid-live だけが live session を持つ */
const statusOf = (sessionId: string): ClaudeStatus | undefined =>
  sessionId === "sid-live" ? WORKING : undefined;

describe("collectActiveSessionGroups", () => {
  test("session が動いている worktree だけをグループにする", () => {
    const groups = collectActiveSessionGroups(POOL_DIRS, repos, new Set(["/repo-a/wt"]), statusOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dir).toBe("/repo-a/wt");
    expect(groups[0]?.rootDir).toBe("/repo-a");
  });

  test("ラベルは repo 名と branch を 1 行に畳む", () => {
    const [group] = collectActiveSessionGroups(POOL_DIRS, repos, new Set(["/repo-a/wt"]), statusOf);
    expect(group?.label).toBe("a · feat");
  });

  test("live session を持たない task は行にしない", () => {
    const [group] = collectActiveSessionGroups(POOL_DIRS, repos, new Set(["/repo-a/wt"]), statusOf);
    expect(group?.entries.map((e) => e.task.id)).toEqual(["live"]);
  });

  test("非 git project は rootDir 自身で判定し repo 名だけのグループになる", () => {
    const groups = collectActiveSessionGroups(POOL_DIRS, repos, new Set(["/note"]), statusOf);
    expect(groups).toEqual([
      { rootDir: "/note", dir: "/note", label: "note", worktree: undefined, entries: [] },
    ]);
  });

  test("task 未紐付けの live session でもグループは残す（hook 到達前の窓）", () => {
    const groups = collectActiveSessionGroups(POOL_DIRS, repos, new Set(["/repo-a"]), statusOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("a · main");
    expect(groups[0]?.entries).toEqual([]);
  });

  test("動いている session が無ければ空", () => {
    expect(collectActiveSessionGroups(POOL_DIRS, repos, new Set(), statusOf)).toEqual([]);
  });

  test("poolDirs に載っているが repos から消えた rootDir は無視する", () => {
    expect(collectActiveSessionGroups(["/ghost"], repos, new Set(["/ghost"]), statusOf)).toEqual(
      [],
    );
  });
});
