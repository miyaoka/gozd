import type { WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { formatTitleContext } from "./useTitleContext";

function wt(path: string, branch: string): WorktreeEntry {
  return {
    path,
    head: "",
    branch,
    isMain: false,
    gitStatuses: {},
    renameOldPaths: {},
    tasks: [],
    upstream: undefined,
    latestMtime: 0,
  };
}

describe("formatTitleContext", () => {
  const repo = { repoName: "gozd", worktrees: [wt("/w/main", "main"), wt("/w/feat", "feat/x")] };

  test("repo が無ければ空文字", () => {
    expect(formatTitleContext(undefined, "/w/main")).toBe("");
  });

  test("dir が無ければ repoName のみ", () => {
    expect(formatTitleContext(repo, undefined)).toBe("gozd");
  });

  test("dir が worktrees に見つからなければ repoName のみ", () => {
    expect(formatTitleContext(repo, "/w/unknown")).toBe("gozd");
  });

  test("repo と worktree が揃えば 'repo · branch'", () => {
    expect(formatTitleContext(repo, "/w/feat")).toBe("gozd · feat/x");
  });

  test("branch が空の worktree は repoName のみ（空要素を join に混ぜない）", () => {
    const detached = { repoName: "gozd", worktrees: [wt("/w/detached", "")] };
    expect(formatTitleContext(detached, "/w/detached")).toBe("gozd");
  });
});
