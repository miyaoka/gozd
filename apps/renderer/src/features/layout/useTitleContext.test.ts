import type { WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { formatTitleContext } from "./useTitleContext";

function wt(path: string, branch: string): WorktreeEntry {
  return {
    path,
    head: "",
    branch,
    detached: false,
    isMain: false,
  };
}

function detachedWt(path: string): WorktreeEntry {
  return { path, head: "3f2a9c1e", branch: "", detached: true, isMain: false };
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

  test("detached の worktree はディレクトリ名で出す", () => {
    const detached = {
      repoName: "gozd",
      worktrees: [detachedWt("/w/check-a"), detachedWt("/w/check-b")],
    };
    expect(formatTitleContext(detached, "/w/check-a")).toBe("gozd · check-a");
    expect(formatTitleContext(detached, "/w/check-b")).toBe("gozd · check-b");
  });
});
