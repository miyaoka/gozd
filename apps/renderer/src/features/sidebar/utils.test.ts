import type { WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { RepoState } from "../../shared/repo";
import { filterClaudeActiveRootDirs } from "./utils";

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
  "/note": {
    rootDir: "/note",
    repoName: "note",
    isGitRepo: false,
    worktrees: [],
  },
};

const DIR_ORDER = ["/repo-a", "/repo-b", "/note"];

describe("filterClaudeActiveRootDirs", () => {
  test("Claude が動いている worktree を持つ repo だけ残す", () => {
    expect(filterClaudeActiveRootDirs(DIR_ORDER, repos, new Set(["/repo-a/wt"]))).toEqual([
      "/repo-a",
    ]);
  });

  test("非 git project は rootDir 自身で判定する", () => {
    expect(filterClaudeActiveRootDirs(DIR_ORDER, repos, new Set(["/note"]))).toEqual(["/note"]);
  });

  test("複数 repo が該当する場合は dirOrder の順序を維持する", () => {
    expect(filterClaudeActiveRootDirs(DIR_ORDER, repos, new Set(["/note", "/repo-b"]))).toEqual([
      "/repo-b",
      "/note",
    ]);
  });

  test("dirOrder に載っているが repos から消えている rootDir は残さない", () => {
    expect(filterClaudeActiveRootDirs(["/ghost", "/repo-a"], repos, new Set(["/repo-a"]))).toEqual([
      "/repo-a",
    ]);
  });

  test("該当 repo が 0 件のときは dirOrder 全体に倒す（teardown 中の空サイドバー防止）", () => {
    // 最後の active-claude worktree の削除では、repos からの worktree 除去（同期）と
    // Claude セッション teardown（RPC 往復後に viewMode が wt へ fallback）に時差があり、
    // その間 claudeActiveDirs には repos に存在しない dir だけが残る
    expect(filterClaudeActiveRootDirs(DIR_ORDER, repos, new Set(["/removed/wt"]))).toEqual(
      DIR_ORDER,
    );
    expect(filterClaudeActiveRootDirs(DIR_ORDER, repos, new Set())).toEqual(DIR_ORDER);
  });
});
