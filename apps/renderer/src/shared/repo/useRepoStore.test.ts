import { Task, type WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { collectFsWatchTargetDirs, dirsOfRepo, type RepoState, useRepoStore } from "./useRepoStore";

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
  return {
    id,
    worktreeDir,
    createdAt: "",
    sessionId: "",
    closedByUser: false,
    userTitle: "",
    terminalTitle: "",
    ghTitle: "",
  };
}

describe("dirsOfRepo", () => {
  test("git repo は配下の全 worktree path を返す（rootDir 自身は worktree として含まれる）", () => {
    const repo: RepoState = {
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat-a")],
    };
    expect(dirsOfRepo(repo)).toEqual(["/r1", "/r1/wt-1"]);
  });

  test("非 git project は rootDir 自身のみを返す", () => {
    const repo: RepoState = {
      rootDir: "/note",
      repoName: "note",
      isGitRepo: false,
      worktrees: [],
    };
    expect(dirsOfRepo(repo)).toEqual(["/note"]);
  });

  test("worktree 未取得（fetch 前）の git repo は空を返す", () => {
    const repo: RepoState = {
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [],
    };
    expect(dirsOfRepo(repo)).toEqual([]);
  });
});

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

  test("removeRepo → 同 rootDir 再追加で applyRepoTasks が再び効く（git 真値フラグの掃除）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1/wt-1", "feat")],
    });
    // 1 回目: git 真値到達でフラグが立つ
    store.updateRepoData("/r1", [wt("/r1/wt-1", "feat")]);

    store.removeRepo("/r1");
    // 再追加（キャッシュから楽観カードを復元した状態）
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1/wt-1", "feat")],
    });

    // フラグが残っていれば no-op になり task が出ない。掃除済みなら prefetch が再び効く。
    store.applyRepoTasks("/r1", [task("t1", "/r1/wt-1")]);
    expect(store.repos["/r1"]?.worktrees[0]?.tasks.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("setGithubIdentity", () => {
  test("既存 repo に identity を書き、updateRepoData（worktrees 差し替え）後も保持する", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1", "main", true)],
    });

    store.setGithubIdentity("/r1", { owner: "miyaoka", repo: "gozd" });
    expect(store.repos["/r1"]?.githubIdentity).toEqual({ owner: "miyaoka", repo: "gozd" });

    // fetchRepo の真値反映（updateRepoData）は worktrees を差し替えるが identity は保持する
    store.updateRepoData("/r1", [wt("/r1", "main", true)]);
    expect(store.repos["/r1"]?.githubIdentity).toEqual({ owner: "miyaoka", repo: "gozd" });
  });

  test("未登録 rootDir への書き込みは no-op（repo エントリを生まない）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.setGithubIdentity("/nope", { owner: "a", repo: "b" });
    expect(store.repos["/nope"]).toBeUndefined();
  });

  test("hydrateFromAppState は fetch 済み identity を引き継ぐ", () => {
    // hydrate は app-state キャッシュから RepoState を作り直すが、dirOrder が変わらない
    // 既存 repo は useSidebarData の新規 dir watch が再発火せず identity を再取得しない。
    // hydrate 前に fetch 済みの値を引き継ぐことで取りこぼしを防ぐ。
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/r1", repoName: "r1", isGitRepo: true, worktrees: [] });
    store.setGithubIdentity("/r1", { owner: "miyaoka", repo: "gozd" });

    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/r1", repoName: "r1", isGitRepo: true, collapsed: false, worktrees: [] },
      ],
    });
    expect(store.repos["/r1"]?.githubIdentity).toEqual({ owner: "miyaoka", repo: "gozd" });
  });
});

describe("buildAppStateSnapshot", () => {
  test("選択中の worktree を activeDir として含める", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat")],
    });
    store.selectDir("/r1/wt-1");
    expect(store.buildAppStateSnapshot().activeDir).toBe("/r1/wt-1");
  });

  test("未選択なら activeDir は undefined（JSON 化でキー不在になる）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    const snapshot = store.buildAppStateSnapshot();
    expect(snapshot.activeDir).toBeUndefined();
    expect(JSON.parse(JSON.stringify(snapshot))).not.toHaveProperty("activeDir");
  });
});
