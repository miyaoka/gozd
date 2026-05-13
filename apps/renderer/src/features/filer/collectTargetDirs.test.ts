import type { WorktreeEntry } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { collectTargetDirs, type RepoStoreForTargetDirs } from "./collectTargetDirs";

function wt(path: string, branch: string, isMain = false): WorktreeEntry {
  return { path, head: "", branch, isMain, gitStatuses: {}, task: undefined };
}

function makeStore(shape: RepoStoreForTargetDirs): RepoStoreForTargetDirs {
  return shape;
}

describe("collectTargetDirs", () => {
  test("空 repo セットでは空集合", () => {
    const store = makeStore({ dirOrder: [], repos: {} });
    expect(collectTargetDirs(store)).toEqual(new Set());
  });

  test("git repo は配下の全 worktree path を集める", () => {
    const store = makeStore({
      dirOrder: ["/r1"],
      repos: {
        "/r1": {
          rootDir: "/r1",
          repoName: "r1",
          isGitRepo: true,
          worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat-a"), wt("/r1/wt-2", "feat-b")],
        },
      },
    });
    expect(collectTargetDirs(store)).toEqual(new Set(["/r1", "/r1/wt-1", "/r1/wt-2"]));
  });

  test("非 git project は rootDir 自身を 1 つだけ集める", () => {
    const store = makeStore({
      dirOrder: ["/note"],
      repos: {
        "/note": {
          rootDir: "/note",
          repoName: "note",
          isGitRepo: false,
          worktrees: [],
        },
      },
    });
    expect(collectTargetDirs(store)).toEqual(new Set(["/note"]));
  });

  test("複数 repo を独立に集めて union を返す", () => {
    // gozd の主用途: マルチ repo / マルチ worktree の同時 watch。
    // 別 repo の worktree もすべて対象に入ることを保証する。
    const store = makeStore({
      dirOrder: ["/repo-a", "/repo-b"],
      repos: {
        "/repo-a": {
          rootDir: "/repo-a",
          repoName: "a",
          isGitRepo: true,
          worktrees: [wt("/repo-a", "main", true), wt("/repo-a/wt", "feat")],
        },
        "/repo-b": {
          rootDir: "/repo-b",
          repoName: "b",
          isGitRepo: true,
          worktrees: [wt("/repo-b", "main", true)],
        },
      },
    });
    expect(collectTargetDirs(store)).toEqual(new Set(["/repo-a", "/repo-a/wt", "/repo-b"]));
  });

  test("dirOrder に載っているが repos から消えている rootDir は無視（hydrate 競合の最終防衛）", () => {
    const store = makeStore({
      dirOrder: ["/ghost", "/alive"],
      repos: {
        "/alive": {
          rootDir: "/alive",
          repoName: "alive",
          isGitRepo: true,
          worktrees: [wt("/alive", "main", true)],
        },
      },
    });
    expect(collectTargetDirs(store)).toEqual(new Set(["/alive"]));
  });
});
