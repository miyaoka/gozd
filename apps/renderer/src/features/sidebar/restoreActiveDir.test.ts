import type { WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";
import { restoreActiveDir } from "./restoreActiveDir";

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

function setupRepo() {
  setActivePinia(createPinia());
  const repoStore = useRepoStore();
  repoStore.addRepo({
    rootDir: "/r1",
    repoName: "r1",
    isGitRepo: true,
    worktrees: [wt("/r1", "main", true), wt("/r1/wt-1", "feat")],
  });
  return { repoStore, worktreeStore: useWorktreeStore() };
}

describe("restoreActiveDir", () => {
  test("保存された dir が repo 所有なら setOpen で復元する（選択イベントも発火）", () => {
    const { repoStore, worktreeStore } = setupRepo();
    restoreActiveDir("/r1/wt-1");
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(worktreeStore.selectionVersion).toBe(1);
  });

  test("既に選択済み（gozdOpen 先着）なら復元せず明示 open を優先する", () => {
    const { repoStore, worktreeStore } = setupRepo();
    worktreeStore.setOpen("/r1");
    restoreActiveDir("/r1/wt-1");
    expect(repoStore.selectedDir).toBe("/r1");
    // 復元による選択イベントの二重発火もない（setOpen 1 回分のまま）
    expect(worktreeStore.selectionVersion).toBe(1);
  });

  test("どの repo にも属さない dir は復元しない", () => {
    const { repoStore } = setupRepo();
    restoreActiveDir("/gone/wt-x");
    expect(repoStore.selectedDir).toBeUndefined();
  });

  test("activeDir 未保存（undefined）は no-op", () => {
    const { repoStore } = setupRepo();
    restoreActiveDir(undefined);
    expect(repoStore.selectedDir).toBeUndefined();
  });
});
