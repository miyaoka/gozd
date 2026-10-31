import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { type RepoWorktree, useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";
import { openRepoDirOnListFailure, restoreActiveDir, settleActiveDir } from "./restoreActiveDir";

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
          { path: "/r1", branch: "main", detached: false, isMain: true },
          { path: "/r1/wt-1", branch: "feat", detached: false, isMain: false },
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
      paths.map((path) => ({
        path,
        head: "",
        branch: "",
        detached: false,
        isMain: path === "/r1",
      })),
    );
  const opened: string[] = [];
  repoStore.$onAction(({ name, args }) => {
    if (name === "selectDir") opened.push(args[0]);
  });
  const messages: string[] = [];
  repoStore.setAutoFallbackNotifier((m) => messages.push(m));
  const settle = () => settleActiveDir((m) => messages.push(m));
  return { repoStore, worktreeStore: useWorktreeStore(), listed, settle, opened, messages };
}

describe("restoreActiveDir", () => {
  test("一覧で確かめ済みの dir はすぐ setOpen で復元する（選択イベントも発火）", () => {
    const { repoStore, worktreeStore } = setupRepo();
    restoreActiveDir("/r1/wt-1");
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(worktreeStore.selectionVersion).toBe(1);
  });

  test("キャッシュから復元しただけの dir は開かず、待つ間も前回の選択として保存する", () => {
    const { repoStore, opened } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    expect(opened).toEqual([]);
    expect(repoStore.buildAppStateSnapshot().activeDir).toBe("/r1/wt-1");
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

describe("settleActiveDir", () => {
  test("一覧に載っていれば前回の worktree を開き、通知しない", () => {
    const { repoStore, worktreeStore, listed, settle, messages } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    listed(["/r1", "/r1/wt-1"]);
    settle();
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(worktreeStore.selectionVersion).toBe(1);
    expect(messages).toEqual([]);
  });

  test("一覧から消えていれば一度も開かずに root を開き、1 回だけ通知する", () => {
    const { repoStore, listed, settle, opened, messages } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    listed(["/r1"]);
    settle();
    // 消えた dir を選ばないので、そこでターミナルを起動しない
    expect(opened).toEqual(["/r1"]);
    expect(repoStore.selectedDir).toBe("/r1");
    expect(messages).toEqual(["Active worktree was removed; switched to r1 root."]);
  });

  test("一覧がまだ反映されていなければ判定せず待ち続ける", () => {
    const { repoStore, listed, settle, opened } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    settle();
    expect(opened).toEqual([]);
    listed(["/r1"]);
    settle();
    expect(repoStore.selectedDir).toBe("/r1");
  });

  test("一覧を待つ間にその repo を解除したら、残りの repo を選び、解除した dir を保存しない", () => {
    const { repoStore, settle } = setupCachedRepo();
    repoStore.addRepo({ rootDir: "/r2", repoName: "r2", isGitRepo: false, worktrees: [] });
    restoreActiveDir("/r1/wt-1");
    repoStore.removeRepo("/r1");
    expect(repoStore.selectedDir).toBe("/r2");
    expect(repoStore.buildAppStateSnapshot().activeDir).toBe("/r2");
    settle();
    expect(repoStore.selectedDir).toBe("/r2");
  });

  test("一覧を待つ間に別の dir が開かれていたら、明示 open を優先して何もしない", () => {
    const { repoStore, worktreeStore, listed, settle, messages } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    worktreeStore.setOpen("/r1");
    expect(repoStore.buildAppStateSnapshot().activeDir).toBe("/r1");
    listed(["/r1", "/r1/wt-1"]);
    settle();
    expect(repoStore.selectedDir).toBe("/r1");
    expect(worktreeStore.selectionVersion).toBe(1);
    expect(messages).toEqual([]);
  });
});

describe("openRepoDirOnListFailure", () => {
  test("一覧の取得に失敗したら、サイドバーを repo の dir だけにして、それを開く", () => {
    const { repoStore, worktreeStore, opened, messages } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    repoStore.showRepoDirOnly("/r1");
    openRepoDirOnListFailure("/r1");
    expect(repoStore.repos["/r1"]?.worktrees.map((wt) => wt.path)).toEqual(["/r1"]);
    // 前回の worktree は確かめられないので、一度も選ばない
    expect(opened).toEqual(["/r1"]);
    expect(worktreeStore.selectionVersion).toBe(1);
    expect(messages).toEqual([]);
  });

  test("別の repo の取得の失敗では開かない", () => {
    const { opened } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    openRepoDirOnListFailure("/r2");
    expect(opened).toEqual([]);
  });

  test("待つ間に開かれた worktree は、明示 open を優先してサイドバーに残し、選択も変えない", () => {
    const { repoStore, worktreeStore } = setupCachedRepo();
    restoreActiveDir("/r1/wt-1");
    worktreeStore.setOpen("/r1/wt-1");
    repoStore.showRepoDirOnly("/r1");
    openRepoDirOnListFailure("/r1");
    expect(repoStore.repos["/r1"]?.worktrees.map((wt) => wt.path)).toEqual(["/r1", "/r1/wt-1"]);
    expect(repoStore.selectedDir).toBe("/r1/wt-1");
    expect(repoStore.findRepoOwning("/r1/wt-1")?.rootDir).toBe("/r1");
    expect(worktreeStore.selectionVersion).toBe(1);
  });
});

describe("showRepoDirOnly", () => {
  test("一覧で確かめた worktree を持つ repo は変えない", () => {
    const { repoStore, listed } = setupCachedRepo();
    listed(["/r1", "/r1/wt-1"]);
    repoStore.showRepoDirOnly("/r1");
    expect(repoStore.repos["/r1"]?.worktrees.map((wt) => wt.path)).toEqual(["/r1", "/r1/wt-1"]);
  });

  test("repo の dir は未確認のまま置き、監視しない。一覧が届けば置き換わる", () => {
    const { repoStore, listed } = setupCachedRepo();
    repoStore.showRepoDirOnly("/r1");
    // 通常の worktree と見分ける印が付く
    expect(repoStore.repos["/r1"]?.worktrees[0]?.listUnavailable).toBe(true);
    expect(repoStore.fsWatchTargetDirs.has("/r1")).toBe(false);
    listed(["/r1", "/r1/wt-2"]);
    expect(repoStore.repos["/r1"]?.worktrees.map((wt) => wt.path)).toEqual(["/r1", "/r1/wt-2"]);
    expect(repoStore.repos["/r1"]?.worktrees[0]?.listUnavailable).toBeUndefined();
    expect(repoStore.fsWatchTargetDirs.has("/r1")).toBe(true);
  });
});
