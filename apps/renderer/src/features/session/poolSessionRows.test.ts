import type { ClaudeSessionSummary } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState, RepoWorktree } from "../../shared/repo";
import type { LiveSession } from "../terminal";
import { collectLivePoolRootDirs, collectPoolSessionRows } from "./poolSessionRows";

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

function listed(sessionId: string, cwd: string, lastModified: string): ClaudeSessionSummary {
  return { sessionId, cwd, title: sessionId, lastModified: Date.parse(lastModified) };
}

const LIVE_AT = Date.parse("2026-07-25T12:00:00.000Z");

const repos: Record<string, RepoState> = {
  "/repo-a": {
    rootDir: "/repo-a",
    repoName: "a",
    isGitRepo: true,
    githubIdentity: { owner: "octo", repo: "a" },
    worktrees: [wt("/repo-a", "main", true)],
  },
  "/repo-b": {
    rootDir: "/repo-b",
    repoName: "b",
    isGitRepo: true,
    worktrees: [wt("/repo-b/wt", "")],
  },
  "/note": {
    rootDir: "/note",
    repoName: "note",
    isGitRepo: false,
    worktrees: [],
  },
};

// 最終活動の古い順に fixture へ並べ、新しい順 (降順) への並べ替えを検出できるようにする
const SESSIONS: Record<string, ClaudeSessionSummary[]> = {
  "/repo-a": [
    listed("old", "/repo-a", "2026-07-25T01:00:00.000Z"),
    listed("live", "/repo-a", "2026-07-25T00:30:00.000Z"),
    // 削除済み worktree のセッションは行にならない
    listed("gone", "/repo-a/removed", "2026-07-25T05:00:00.000Z"),
  ],
  "/repo-b": [listed("new", "/repo-b/wt", "2026-07-25T02:00:00.000Z")],
  "/note": [listed("note", "/note", "2026-07-25T00:10:00.000Z")],
};
const sessionsOf = (rootDir: string) => SESSIONS[rootDir] ?? [];

const LIVE: LiveSession[] = [
  {
    sessionId: "live",
    dir: "/repo-a",
    status: { state: "working", lastActivityAt: LIVE_AT },
    stateSince: LIVE_AT,
    terminalTitle: "",
  },
  // ログに現れる前（最初のプロンプト前）のセッション
  { sessionId: "fresh", dir: "/note", status: undefined, stateSince: undefined, terminalTitle: "" },
];

const POOL_DIRS = ["/repo-a", "/repo-b", "/note"];

describe("collectPoolSessionRows", () => {
  test("端末の有無で分けず、最終活動の降順に並べる。記録の無い新しいセッションは先頭", () => {
    const rows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE);
    expect(rows.map((r) => r.sessionId)).toEqual(["fresh", "live", "new", "old", "note"]);
  });

  test("端末が開いているセッションは Claude の最終活動を採る", () => {
    const rows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE);
    const live = rows.find((r) => r.sessionId === "live");
    expect(live?.live).toBe(true);
    expect(live?.lastActivity).toBe(LIVE_AT);
  });

  test("作業ディレクトリが現存しないセッションは行にならない", () => {
    const rows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE);
    expect(rows.some((r) => r.sessionId === "gone")).toBe(false);
  });

  test("非 git project のセッションはブランチを持たない行になる", () => {
    const rows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE);
    const note = rows.find((r) => r.sessionId === "note");
    expect(note?.dir).toBe("/note");
    expect(note?.branch).toBe("");
  });

  test("poolDirs に載っているが repos から消えた rootDir は無視する", () => {
    expect(collectPoolSessionRows(["/ghost"], repos, sessionsOf, LIVE)).toEqual([]);
  });

  test("行は repo 名・owner・branch ラベル・ジャンプ先 dir を持つ", () => {
    const rows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE);
    const live = rows.find((r) => r.sessionId === "live");
    expect(live?.repoName).toBe("a");
    expect(live?.owner).toBe("octo");
    expect(live?.dir).toBe("/repo-a");
    // detached HEAD (空 branch) はラベルに倒す
    const detached = rows.find((r) => r.sessionId === "new");
    expect(detached?.branch).toBe("(detached)");
    expect(detached?.owner).toBeUndefined();
  });
});

describe("collectLivePoolRootDirs", () => {
  test("collectPoolSessionRows の live 行と同じ repo を返す", () => {
    const fromRows = collectPoolSessionRows(POOL_DIRS, repos, sessionsOf, LIVE)
      .filter((r) => r.live)
      .map((r) => r.rootDir);
    const rootDirs = collectLivePoolRootDirs(POOL_DIRS, repos, LIVE);
    expect(rootDirs.toSorted()).toEqual(fromRows.toSorted());
    expect(rootDirs.toSorted()).toEqual(["/note", "/repo-a"]);
  });

  test("プールに無い repo と、repo の作業ディレクトリに無い端末は含めない", () => {
    const outside: LiveSession[] = [
      ...LIVE,
      {
        sessionId: "gone",
        dir: "/repo-a/removed",
        status: undefined,
        stateSince: undefined,
        terminalTitle: "",
      },
    ];
    expect(collectLivePoolRootDirs(["/repo-a"], repos, outside)).toEqual(["/repo-a"]);
  });
});
