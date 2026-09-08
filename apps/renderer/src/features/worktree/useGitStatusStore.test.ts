import type { WorktreeEntry } from "@gozd/rpc";
import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { useGitStatusStore } from "./useGitStatusStore";

/**
 * `hasHeadCommit` は blame / ファイル履歴の起動要素を出すかの前提条件で、false のとき
 * git は exit 128 に倒れる。`head` の空文字がそのまま通ると押した瞬間に失敗するボタンが
 * 残るため、空文字 → false の写像を固定する。
 */
const DIR = "/repo";

function wt(head: string): WorktreeEntry {
  return {
    path: DIR,
    head,
    branch: "main",
    isMain: true,
    gitStatuses: {},
    renameOldPaths: {},
    tasks: [],
    upstream: undefined,
    latestMtime: 0,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useRepoStore().selectDir(DIR);
});

describe("useGitStatusStore の hasHeadCommit", () => {
  test("HEAD の OID が観測されていれば true", () => {
    useRepoStore().addRepo({
      rootDir: DIR,
      repoName: "repo",
      isGitRepo: true,
      worktrees: [wt("79da6a2fbdba1cb4f0484a5c1eda47301bf0868c")],
    });
    expect(useGitStatusStore().hasHeadCommit).toBe(true);
  });

  test("head が空文字 (bare / unborn / 未取得) なら false", () => {
    useRepoStore().addRepo({
      rootDir: DIR,
      repoName: "repo",
      isGitRepo: true,
      worktrees: [wt("")],
    });
    expect(useGitStatusStore().hasHeadCommit).toBe(false);
  });

  test("worktree entry を持たない非 git project は false", () => {
    useRepoStore().addRepo({
      rootDir: DIR,
      repoName: "repo",
      isGitRepo: false,
      worktrees: [],
    });
    expect(useGitStatusStore().hasHeadCommit).toBe(false);
  });
});
