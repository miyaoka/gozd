import type { WorktreeEntry } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { collectFsWatchTargetDirs, type RepoState } from "./useRepoStore";

function wt(path: string, branch: string, isMain = false): WorktreeEntry {
  return {
    path,
    head: "",
    branch,
    isMain,
    gitStatuses: {},
    renameOldPaths: {},
    tasks: [],
    upstream: undefined,
    latestMtime: 0,
  };
}

describe("collectFsWatchTargetDirs", () => {
  test("空 repo セットでは空集合", () => {
    expect(collectFsWatchTargetDirs([], {})).toEqual(new Set());
  });

  test("git repo は配下の全 worktree path を集める", () => {
    const repos: Record<string, RepoState> = {
      "/r1": {
        rootDir: "/r1",
        repoName: "r1",
        isGitRepo: true,
        worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat-a"), wt("/r1/wt-2", "feat-b")],
      },
    };
    expect(collectFsWatchTargetDirs(["/r1"], repos)).toEqual(
      new Set(["/r1", "/r1/wt-1", "/r1/wt-2"]),
    );
  });

  test("非 git project は rootDir 自身を 1 つだけ集める", () => {
    const repos: Record<string, RepoState> = {
      "/note": {
        rootDir: "/note",
        repoName: "note",
        isGitRepo: false,
        worktrees: [],
      },
    };
    expect(collectFsWatchTargetDirs(["/note"], repos)).toEqual(new Set(["/note"]));
  });

  test("複数 repo を独立に集めて union を返す", () => {
    // gozd の主用途: マルチ repo / マルチ worktree の同時 watch。
    // 別 repo の worktree もすべて対象に入ることを保証する。
    const repos: Record<string, RepoState> = {
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
    };
    expect(collectFsWatchTargetDirs(["/repo-a", "/repo-b"], repos)).toEqual(
      new Set(["/repo-a", "/repo-a/wt", "/repo-b"]),
    );
  });

  test("dirOrder に載っているが repos から消えている rootDir は無視（hydrate 競合の最終防衛）", () => {
    const repos: Record<string, RepoState> = {
      "/alive": {
        rootDir: "/alive",
        repoName: "alive",
        isGitRepo: true,
        worktrees: [wt("/alive", "main", true)],
      },
    };
    expect(collectFsWatchTargetDirs(["/ghost", "/alive"], repos)).toEqual(new Set(["/alive"]));
  });
});
