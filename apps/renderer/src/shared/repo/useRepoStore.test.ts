import { Task, type WorktreeEntry } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { collectFsWatchTargetDirs, type RepoState, useRepoStore } from "./useRepoStore";

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

function task(id: string, worktreeDir: string): Task {
  return Task.fromPartial({ id, worktreeDir });
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

describe("applyRepoTasks", () => {
  test("worktreeDir で task を各 wt に割り当て、gitStatuses 等は保持する", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [
        { ...wt("/r1", "main", true), gitStatuses: { "a.txt": ".M" } },
        wt("/r1/wt-1", "feat"),
      ],
    });

    store.applyRepoTasks("/r1", [task("t2", "/r1"), task("t1", "/r1/wt-1")]);

    const repo = store.repos["/r1"];
    expect(repo?.worktrees[0]?.tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(repo?.worktrees[1]?.tasks.map((t) => t.id)).toEqual(["t1"]);
    // tasks のみ差し替え。git status 等の他フィールドは保持する。
    expect(repo?.worktrees[0]?.gitStatuses).toEqual({ "a.txt": ".M" });
  });

  test("git 真値（updateRepoData）到達後の applyRepoTasks は no-op（prefetch race ガード）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1/wt-1", "feat")],
    });

    // git 真値が先に到達（往復中に増えた t-new を含む最新 task）
    store.updateRepoData("/r1", [
      { ...wt("/r1/wt-1", "feat"), tasks: [task("t-new", "/r1/wt-1")] },
    ]);
    // 古い prefetch スナップショット（t-new を含まない）が後着しても真値を消さない
    store.applyRepoTasks("/r1", []);

    expect(store.repos["/r1"]?.worktrees[0]?.tasks.map((t) => t.id)).toEqual(["t-new"]);
  });
});
