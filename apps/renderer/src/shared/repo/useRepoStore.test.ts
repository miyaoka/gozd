import type { ClaudeSessionSummary } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import {
  collectFsWatchTargetDirs,
  type RepoState,
  type RepoWorktree,
  repoDirEntries,
  useRepoStore,
} from "./useRepoStore";

function wt(path: string, branch: string, isMain = false): RepoWorktree {
  return {
    path,
    head: "",
    branch,
    isMain,
    gitStatuses: {},
    renameOldPaths: {},
    upstream: undefined,
    latestMtime: 0,
  };
}

function session(sessionId: string, cwd: string): ClaudeSessionSummary {
  return { sessionId, cwd, title: sessionId, lastModified: 0 };
}

describe("repoDirEntries", () => {
  test("git repo は配下の全 worktree を worktree entry 付きで返す（rootDir 自身も worktree）", () => {
    const main = wt("/r1", "main", true);
    const feat = wt("/r1/wt-1", "feat-a");
    const repo: RepoState = {
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [main, feat],
    };
    expect(repoDirEntries(repo)).toEqual([
      { dir: "/r1", worktree: main },
      { dir: "/r1/wt-1", worktree: feat },
    ]);
  });

  test("非 git project は rootDir 自身のみを worktree なしで返す", () => {
    const repo: RepoState = {
      rootDir: "/note",
      repoName: "note",
      isGitRepo: false,
      worktrees: [],
    };
    expect(repoDirEntries(repo)).toEqual([{ dir: "/note", worktree: undefined }]);
  });

  test("worktree 未取得（fetch 前）の git repo は空を返す", () => {
    const repo: RepoState = {
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [],
    };
    expect(repoDirEntries(repo)).toEqual([]);
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

describe("sessions", () => {
  test("repo ごとにセッションを引き、sessionId で repo 横断に引ける", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat")],
    });
    store.addRepo({ rootDir: "/note", repoName: "note", isGitRepo: false, worktrees: [] });

    store.setRepoSessions("/r1", [session("s1", "/r1/wt-1"), session("s2", "/r1")]);
    store.setRepoSessions("/note", [session("s3", "/note")]);

    expect(store.sessionsOf("/r1").map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(store.sessionsOf("/ghost")).toEqual([]);
    expect(store.findSession("s3")?.cwd).toBe("/note");
  });

  test("未登録の repo へのセッションは書かない", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.setRepoSessions("/ghost", [session("s1", "/ghost")]);
    expect(store.findSession("s1")).toBeUndefined();
  });

  test("removeRepo でその repo のセッションも消える", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/r1", repoName: "r1", isGitRepo: true, worktrees: [] });
    store.setRepoSessions("/r1", [session("s1", "/r1")]);

    store.removeRepo("/r1");

    expect(store.findSession("s1")).toBeUndefined();
  });
});

describe("concierge", () => {
  test("窓口は project として引けるが、プールと永続化には載らない", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/a", repoName: "a", isGitRepo: false, worktrees: [] });
    store.setConciergeDir("/concierge");

    expect(store.findRepoOwning("/concierge")?.repoName).toBe("Concierge");
    expect(store.repoAt("/concierge")?.isGitRepo).toBe(false);
    expect(store.poolDirs).toEqual(["/a"]);
    expect(store.buildAppStateSnapshot().sidebarRepos.map((r) => r.rootDir)).toEqual(["/a"]);
    expect([...store.fsWatchTargetDirs]).toContain("/concierge");
  });

  test("窓口を選ぶと selectedRepo が窓口になる", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.setConciergeDir("/concierge");
    store.selectDir("/concierge");
    expect(store.selectedRepo?.rootDir).toBe("/concierge");
  });

  test("窓口のセッションを持てる", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.setConciergeDir("/concierge");
    store.setRepoSessions("/concierge", [session("s1", "/concierge")]);
    expect(store.findSession("s1")?.cwd).toBe("/concierge");
  });

  test("app-state の復元で窓口は消えない", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.setConciergeDir("/concierge");
    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/a", repoName: "a", isGitRepo: false, collapsed: false, worktrees: [] },
      ],
      repoLists: [],
      activeRepoListId: "",
    });
    expect(store.findRepoOwning("/concierge")?.rootDir).toBe("/concierge");
  });
});

describe("updateRepoData", () => {
  const observed = {
    statuses: { "b.txt": "R." },
    renameOldPaths: { "b.txt": "a.txt" },
    upstream: { ahead: 1, behind: 0 },
    latestMtime: 42,
  };

  test("一覧は status を運ばないので、同じ path の worktree の status を引き継ぐ", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1/wt-1", "feat")],
    });
    store.setWorktreeGitStatuses("/r1/wt-1", { ...observed, head: "h" });

    store.updateRepoData("/r1", [{ path: "/r1/wt-1", head: "h", branch: "feat", isMain: false }]);

    const target = store.repos["/r1"]?.worktrees[0];
    expect(target?.gitStatuses).toEqual({ "b.txt": "R." });
    expect(target?.renameOldPaths).toEqual({ "b.txt": "a.txt" });
    expect(target?.upstream).toEqual({ ahead: 1, behind: 0 });
    expect(target?.latestMtime).toBe(42);
  });

  test("新しく現れた worktree は status 未観測で始まる", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/r1", repoName: "r1", isGitRepo: true, worktrees: [] });

    store.updateRepoData("/r1", [{ path: "/r1/new", head: "h", branch: "new", isMain: false }]);

    const target = store.repos["/r1"]?.worktrees[0];
    expect(target?.gitStatuses).toEqual({});
    expect(target?.upstream).toBeUndefined();
    expect(target?.latestMtime).toBe(0);
  });

  test("往復中に status が head を書いた wt は、一覧の古い head で巻き戻さない", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [{ ...wt("/r1/wt-1", "feat"), head: "old" }],
    });

    const headGenSnapshot = new Map([["/r1/wt-1", store.getObservationGen("/r1/wt-1").head]]);
    store.setWorktreeGitStatuses("/r1/wt-1", { ...observed, head: "new" });
    store.updateRepoData("/r1", [{ ...wt("/r1/wt-1", "feat"), head: "old" }], headGenSnapshot);

    expect(store.repos["/r1"]?.worktrees[0]?.head).toBe("new");
  });

  test("往復中に head の観測が無ければ一覧の head を採る", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [{ ...wt("/r1/wt-1", "feat"), head: "old" }],
    });
    store.setWorktreeGitStatuses("/r1/wt-1", { ...observed, head: "current" });

    const headGenSnapshot = new Map([["/r1/wt-1", store.getObservationGen("/r1/wt-1").head]]);
    store.updateRepoData("/r1", [{ ...wt("/r1/wt-1", "feat"), head: "fetched" }], headGenSnapshot);

    expect(store.repos["/r1"]?.worktrees[0]?.head).toBe("fetched");
  });

  test("一覧の反映は status の世代を進めない（往復中の単発 status を捨てさせない）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({
      rootDir: "/r1",
      repoName: "r1",
      isGitRepo: true,
      worktrees: [wt("/r1/wt-1", "feat")],
    });

    const before = store.getObservationGen("/r1/wt-1");
    const headGenSnapshot = new Map([["/r1/wt-1", before.head]]);
    store.updateRepoData("/r1", [wt("/r1/wt-1", "feat")], headGenSnapshot);

    expect(store.getObservationGen("/r1/wt-1").status).toBe(before.status);
    expect(store.getObservationGen("/r1/wt-1").head).not.toBe(before.head);
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
      repoLists: [],
      activeRepoListId: "",
    });
    expect(store.repos["/r1"]?.githubIdentity).toEqual({ owner: "miyaoka", repo: "gozd" });
  });
});

describe("repoLists", () => {
  function repo(rootDir: string): RepoState {
    return { rootDir, repoName: rootDir.slice(1), isGitRepo: true, worktrees: [] };
  }

  test("addRepo はアクティブ repo list の末尾に追加する", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    store.addRepo(repo("/b"));
    expect(store.dirOrder).toEqual(["/a", "/b"]);
    expect(store.poolDirs).toEqual(["/a", "/b"]);
  });

  test("repo list 切り替えで dirOrder が変わり、poolDirs は union を保つ", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    const firstId = store.activeRepoListId;
    const secondId = store.addRepoList("second");
    // addRepoList はアクティブを切り替えるので /b は second に入る
    store.addRepo(repo("/b"));
    expect(store.dirOrder).toEqual(["/b"]);
    expect(store.poolDirs).toEqual(["/a", "/b"]);
    store.setActiveRepoList(firstId);
    expect(store.dirOrder).toEqual(["/a"]);
    expect(store.repoListsContaining("/b").map((p) => p.id)).toEqual([secondId]);
  });

  test("removeFromActiveRepoList はプールを維持し、removeRepo は全 repo list から消す", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    const firstId = store.activeRepoListId;
    store.addRepoList("second");
    store.ensureInActiveRepoList("/a");
    expect(store.repoListsContaining("/a")).toHaveLength(2);

    store.removeFromActiveRepoList("/a");
    expect(store.dirOrder).toEqual([]);
    expect(store.poolDirs).toEqual(["/a"]);
    expect(store.repos["/a"]).toBeDefined();

    store.setActiveRepoList(firstId);
    store.removeRepo("/a");
    expect(store.poolDirs).toEqual([]);
    expect(store.repos["/a"]).toBeUndefined();
  });

  test("removeRepo の選択フォールバックが別 list に倒れたらアクティブ list も追従する", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    const firstId = store.activeRepoListId;
    const secondId = store.addRepoList("second");
    store.addRepo(repo("/b"));
    store.setActiveRepoList(firstId);
    store.selectDir("/a");

    // アクティブ list (first) 唯一の repo を window から解除 → dirOrder が空になり
    // プール先頭 /b（second 所属）へ倒れる。選択だけ移してアクティブ list を first のまま
    // 残すと「サイドバーは empty state / terminal は /b」の表示ずれになる
    store.removeRepo("/a");
    expect(store.selectedDir).toBe("/b");
    expect(store.activeRepoListId).toBe(secondId);
    expect(store.dirOrder).toEqual(["/b"]);
  });

  test("activateRepoListContaining: アクティブ list 内は no-op / list 外は含む先頭 list へ切り替える", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    const firstId = store.activeRepoListId;
    const secondId = store.addRepoList("second");
    store.addRepo(repo("/b"));
    const thirdId = store.addRepoList("third");
    store.ensureInActiveRepoList("/b");

    // アクティブ list (third) が既に含む repo は no-op
    store.activateRepoListContaining("/b");
    expect(store.activeRepoListId).toBe(thirdId);

    // 単一所属: /a を含むのは first のみ
    store.activateRepoListContaining("/a");
    expect(store.activeRepoListId).toBe(firstId);

    // 複数所属: /b は second / third に属する → repoLists 先頭側の second に倒す
    store.activateRepoListContaining("/b");
    expect(store.activeRepoListId).toBe(secondId);
  });

  test("removeRepoList は最後の 1 個を拒否し、孤児 repo を先頭 repo list へ移す", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    const firstId = store.activeRepoListId;
    store.addRepo(repo("/a"));
    const secondId = store.addRepoList("second");
    store.addRepo(repo("/b"));

    store.setActiveRepoList(firstId);
    store.removeRepoList(firstId);
    // 2 個あるので削除は成立。/a は second に属さない孤児なので second へ移る
    expect(store.repoLists.map((p) => p.id)).toEqual([secondId]);
    expect(store.repoLists[0]?.dirOrder).toEqual(["/b", "/a"]);
    expect(store.activeRepoListId).toBe(secondId);

    // 最後の 1 個は削除できない
    store.removeRepoList(secondId);
    expect(store.repoLists).toHaveLength(1);
  });

  test("hydrate: repoLists 空（旧ファイル）は全プール repo を含む Default 1 個に正規化する", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/a", repoName: "a", isGitRepo: true, collapsed: false, worktrees: [] },
        { rootDir: "/b", repoName: "b", isGitRepo: true, collapsed: true, worktrees: [] },
      ],
      repoLists: [],
      activeRepoListId: "",
    });
    expect(store.repoLists).toHaveLength(1);
    expect(store.dirOrder).toEqual(["/a", "/b"]);
    expect(store.isCollapsed("/b")).toBe(true);
  });

  test("hydrate: プール外 dir の除去 / activeRepoListId 復元 / 未所属 repo の先頭 repo list 併合", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/a", repoName: "a", isGitRepo: true, collapsed: false, worktrees: [] },
        { rootDir: "/b", repoName: "b", isGitRepo: true, collapsed: false, worktrees: [] },
        { rootDir: "/c", repoName: "c", isGitRepo: true, collapsed: false, worktrees: [] },
      ],
      repoLists: [
        { id: "p1", name: "one", dirOrder: ["/a", "/ghost"] },
        { id: "p2", name: "two", dirOrder: ["/b"] },
      ],
      activeRepoListId: "p2",
    });
    // /ghost はプール外なので除去、/c はどの repo list にも無いので先頭 p1 の末尾へ
    expect(store.repoLists.map((p) => p.dirOrder)).toEqual([["/a", "/c"], ["/b"]]);
    expect(store.activeRepoListId).toBe("p2");
    expect(store.dirOrder).toEqual(["/b"]);
    expect(store.poolDirs).toEqual(["/a", "/c", "/b"]);
  });

  test("hydrate: 迷子の activeRepoListId は先頭 repo list に倒す", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/a", repoName: "a", isGitRepo: true, collapsed: false, worktrees: [] },
      ],
      repoLists: [{ id: "p1", name: "one", dirOrder: ["/a"] }],
      activeRepoListId: "gone",
    });
    expect(store.activeRepoListId).toBe("p1");
  });

  test("hydrate 前に gozdOpen で追加された repo は repo list にも併合される（先勝ち merge）", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/pre"));
    store.hydrateFromAppState({
      sidebarRepos: [
        { rootDir: "/a", repoName: "a", isGitRepo: true, collapsed: false, worktrees: [] },
      ],
      repoLists: [{ id: "p1", name: "one", dirOrder: ["/a"] }],
      activeRepoListId: "p1",
    });
    expect(store.poolDirs).toEqual(["/a", "/pre"]);
    expect(store.dirOrder).toEqual(["/a", "/pre"]);
    expect(store.repos["/pre"]).toBeDefined();
  });

  test("buildAppStateSnapshot は repoLists / activeRepoListId を含み、sidebarRepos はプール全量", () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo(repo("/a"));
    store.addRepoList("second");
    store.addRepo(repo("/b"));
    const snapshot = store.buildAppStateSnapshot();
    expect(snapshot.sidebarRepos.map((r) => r.rootDir)).toEqual(["/a", "/b"]);
    expect(snapshot.repoLists.map((p) => p.dirOrder)).toEqual([["/a"], ["/b"]]);
    expect(snapshot.activeRepoListId).toBe(store.activeRepoListId);
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
