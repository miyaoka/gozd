import type { Task } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState, RepoWorktree } from "../../shared/repo";
import { collectInactiveSessionIds, enteredSessionIds } from "./inactiveSessionIds";

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

function wt(path: string, tasks: Task[]): RepoWorktree {
  return {
    path,
    head: "",
    branch: "main",
    isMain: true,
    gitStatuses: {},
    renameOldPaths: {},
    tasks,
    upstream: undefined,
    latestMtime: 0,
  };
}

const repos: Record<string, RepoState> = {
  "/a": {
    rootDir: "/a",
    repoName: "a",
    isGitRepo: true,
    worktrees: [wt("/a", [task("live", "sid-live"), task("stopped", "sid-stopped")])],
  },
  "/b": {
    rootDir: "/b",
    repoName: "b",
    isGitRepo: true,
    worktrees: [wt("/b", [task("not-started", ""), task("stopped-b", "sid-b")])],
  },
};

describe("collectInactiveSessionIds", () => {
  test("session を持ち live でない sessionId だけを集める", () => {
    const ids = collectInactiveSessionIds(["/a", "/b"], repos, (sid) => sid === "sid-live");
    expect(ids).toEqual(["sid-stopped", "sid-b"]);
  });

  test("poolDirs に無い repo の task は含めない", () => {
    expect(collectInactiveSessionIds(["/a"], repos, () => false)).toEqual([
      "sid-live",
      "sid-stopped",
    ]);
  });
});

describe("enteredSessionIds", () => {
  test("初回は全件を読み込み対象にする", () => {
    expect(enteredSessionIds(["x", "y"])).toEqual(["x", "y"]);
  });

  test("集合に残っている sessionId は読み直さない", () => {
    expect(enteredSessionIds(["x", "y"], ["x", "y"])).toEqual([]);
  });

  test("live になって集合から外れた sessionId が戻ると読み直す", () => {
    const whileLive = enteredSessionIds(["y"], ["x", "y"]);
    expect(whileLive).toEqual([]);
    expect(enteredSessionIds(["x", "y"], ["y"])).toEqual(["x"]);
  });
});
