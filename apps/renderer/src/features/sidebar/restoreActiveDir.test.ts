import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { type RepoWorktree, useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";
import { restoreActiveDir, settleActiveDir } from "./restoreActiveDir";

function wt(path: string, branch: string, isMain = false): RepoWorktree {
  return {
    path,
    head: "",
    branch,
    detached: false,
    isMain,
    gitStatuses: {},
    renameOldPaths: {},
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

/** app-state のキャッシュから復元した直後の repo（worktree は git の一覧で未確認） */
function setupCachedRepo() {
  setActivePinia(createPinia());
  const repoStore = useRepoStore();
  repoStore.hydrateFromAppState({
    sidebarRepos: [
      {
        rootDir: "/r1",
        repoName: "r1",
        isGitRepo: true,
        collapsed: false,
        worktrees: [
          { path: "/r1", branch: "main", isMain: true },
          { path: "/r1/wt-1", branch: "feat", isMain: false },
        ],
      },
    ],
    repoLists: [],
    activeRepoListId: "",
    activeDir: "/r1/wt-1",
  });
  // 起動時の fetchRepo と同じく、git の一覧を store に反映する
  const listed = (paths: string[]) =>
    repoStore.updateRepoData(
      "/r1",
      paths.map((path) => ({ path, head: "", branch: "", isMain: path === "/r1" })),
    );
  return { repoStore, worktreeStore: useWorktreeStore(), listed };
}

describe("restoreActiveDir", () => {
  test("一覧で確かめ済みの dir はすぐ setOpen で復元する（選択イベントも発火）", () => {
    const { repoStore, worktreeStore } = setupRepo();
    expect(restoreActiveDir("/r1/wt-1")).toBeUndefined();
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(worktreeStore.selectionVersion).toBe(1);
  });

  test("キャッシュから復元しただけの dir は開かず、所属 repo の一覧を待つ", () => {
    const { repoStore } = setupCachedRepo();
    expect(restoreActiveDir("/r1/wt-1")).toEqual({ rootDir: "/r1", dir: "/r1/wt-1" });
    expect(repoStore.selectedDir).toBeUndefined();
  });

  test("既に選択済み（gozdOpen 先着）なら復元せず明示 open を優先する", () => {
    const { repoStore, worktreeStore } = setupRepo();
    worktreeStore.setOpen("/r1");
    expect(restoreActiveDir("/r1/wt-1")).toBeUndefined();
    expect(repoStore.selectedDir).toBe("/r1");
    // 復元による選択イベントの二重発火もない（setOpen 1 回分のまま）
    expect(worktreeStore.selectionVersion).toBe(1);
  });

  test("どの repo にも属さない dir は復元しない", () => {
    const { repoStore } = setupRepo();
    expect(restoreActiveDir("/gone/wt-x")).toBeUndefined();
    expect(repoStore.selectedDir).toBeUndefined();
  });

  test("activeDir 未保存（undefined）は no-op", () => {
    const { repoStore } = setupRepo();
    expect(restoreActiveDir(undefined)).toBeUndefined();
    expect(repoStore.selectedDir).toBeUndefined();
  });
});

describe("settleActiveDir", () => {
  test("一覧に載っていれば前回の worktree を開き、通知しない", () => {
    const { repoStore, worktreeStore, listed } = setupCachedRepo();
    const pending = restoreActiveDir("/r1/wt-1");
    if (pending === undefined) throw new Error("pending expected");
    listed(["/r1", "/r1/wt-1"]);
    const messages: string[] = [];
    settleActiveDir(pending, (m) => messages.push(m));
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(worktreeStore.selectionVersion).toBe(1);
    expect(messages).toEqual([]);
  });

  test("一覧から消えていれば一度も開かずに root を開き、1 回だけ通知する", () => {
    const { repoStore, listed } = setupCachedRepo();
    const messages: string[] = [];
    repoStore.setAutoFallbackNotifier((m) => messages.push(m));
    const opened: string[] = [];
    repoStore.$onAction(({ name, args }) => {
      if (name === "selectDir") opened.push(args[0]);
    });
    const pending = restoreActiveDir("/r1/wt-1");
    if (pending === undefined) throw new Error("pending expected");
    listed(["/r1"]);
    settleActiveDir(pending, (m) => messages.push(m));
    // 消えた dir を選ばないので、そこでターミナルを起動しない
    expect(opened).toEqual(["/r1"]);
    expect(repoStore.selectedDir).toBe("/r1");
    expect(messages).toEqual(["Active worktree was removed; switched to r1 root."]);
  });

  test("一覧を待つ間に別の dir が開かれていたら、明示 open を優先して何もしない", () => {
    const { repoStore, worktreeStore, listed } = setupCachedRepo();
    const pending = restoreActiveDir("/r1/wt-1");
    if (pending === undefined) throw new Error("pending expected");
    worktreeStore.setOpen("/r1");
    listed(["/r1"]);
    const messages: string[] = [];
    settleActiveDir(pending, (m) => messages.push(m));
    expect(repoStore.selectedDir).toBe("/r1");
    expect(worktreeStore.selectionVersion).toBe(1);
    expect(messages).toEqual([]);
  });
});
