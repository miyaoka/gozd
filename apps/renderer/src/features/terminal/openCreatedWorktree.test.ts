import type { CreateTaskWorktreeResponse, WorktreeEntry } from "@gozd/rpc";
import { describe, expect, spyOn, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "../worktree";
import { openCreatedWorktree } from "./openCreatedWorktree";
import { collectLeafIds } from "./splitTree";
import { useTerminalStore } from "./useTerminalStore";

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

const CREATED_DIR = "/r1/wt-new";

function created(rootDir = "/r1"): CreateTaskWorktreeResponse {
  return {
    rootDir,
    worktree: wt(CREATED_DIR, "feat/new"),
    dir: CREATED_DIR,
    task: {
      id: "t1",
      worktreeDir: CREATED_DIR,
      createdAt: "2026-08-27T00:00:00.000Z",
      sessionId: "",
      closedByUser: false,
      userTitle: "new task",
      terminalTitle: "",
      ghTitle: "",
    },
    setupScript: "",
  };
}

function setup() {
  setActivePinia(createPinia());
  const repoStore = useRepoStore();
  repoStore.addRepo({
    rootDir: "/r1",
    repoName: "r1",
    isGitRepo: true,
    worktrees: [wt("/r1", "main", true)],
  });
  const terminalStore = useTerminalStore();
  const worktreeStore = useWorktreeStore();
  return { repoStore, terminalStore, worktreeStore };
}

describe("openCreatedWorktree", () => {
  test("background: 選択を動かさずに端末を起こす", () => {
    const { repoStore, terminalStore, worktreeStore } = setup();
    worktreeStore.setOpen("/r1");

    openCreatedWorktree(created(), { prompt: "do it" }, "background");

    // 人の作業中に画面が切り替わらない
    expect(repoStore.selectedDir).toBe("/r1");
    // それでも端末は起きる（訪問が選択に依存しない）
    expect(terminalStore.visitedDirs).toContain(CREATED_DIR);
    expect(terminalStore.layoutsByDir[CREATED_DIR]).toBeDefined();
  });

  test("background: claude 起動のヒントが初期 leaf に載る（訪問より先に立つ）", () => {
    const { terminalStore, worktreeStore } = setup();
    worktreeStore.setOpen("/r1");

    openCreatedWorktree(created(), { prompt: "do it" }, "background");

    // ヒントの保持先は store の公開面に出ないため、消費の位置で観測する。訪問より後に
    // 立てると訪問済み経路の prependPane に落ちて leaf が 2 つになり、初期 leaf は
    // 素のシェルのまま残る
    const layout = terminalStore.layoutsByDir[CREATED_DIR];
    if (layout === undefined) throw new Error("layout was not created");
    expect(collectLeafIds(layout.root)).toHaveLength(1);
  });

  test("foreground: 作成した worktree を選択して前面に出す", () => {
    const { repoStore, terminalStore, worktreeStore } = setup();
    worktreeStore.setOpen("/r1");

    openCreatedWorktree(created(), { prefill: "https://example.test/pr/1" }, "foreground");

    expect(repoStore.selectedDir).toBe(CREATED_DIR);
    expect(terminalStore.viewMode).toBe("wt");
    expect(terminalStore.visitedDirs).toContain(CREATED_DIR);
  });

  test("掲載先の repo が引けなければ通知して端末を起こさない", () => {
    const { repoStore, terminalStore, worktreeStore } = setup();
    worktreeStore.setOpen("/r1");
    // 通知は store 内部で console へも出る。黙らせるだけでなく発火を契約として固定する
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    openCreatedWorktree(created("/unknown"), { prompt: "do it" }, "background");

    expect(consoleError).toHaveBeenCalledWith("Worktree created but sidebar could not be updated");
    consoleError.mockRestore();

    expect(terminalStore.visitedDirs).not.toContain(CREATED_DIR);
    expect(repoStore.selectedDir).toBe("/r1");
  });
});
