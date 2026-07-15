import { ghRefForIssue, ghRefForPr } from "@gozd/rpc";
import type { Task, WorktreeEntry } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { buildTaskIndexByGhRef, ghRefKey } from "./taskIndexByGhRef";

function makeTask(partial: Partial<Task>): Task {
  return {
    id: "task-1",
    worktreeDir: "/wt",
    createdAt: "2026-07-15T01:49:28Z",
    sessionId: "",
    closedByUser: false,
    userTitle: "",
    terminalTitle: "",
    ghTitle: "",
    ...partial,
  };
}

function makeWt(tasks: Task[]): WorktreeEntry {
  return {
    path: "/wt",
    head: "",
    branch: "",
    isMain: false,
    gitStatuses: {},
    renameOldPaths: {},
    tasks,
    latestMtime: 0,
  };
}

describe("buildTaskIndexByGhRef", () => {
  test("ghRef を持たない task は index に載らない", () => {
    const index = buildTaskIndexByGhRef([makeWt([makeTask({})])]);
    expect(index.size).toBe(0);
  });

  // GitHub は PR と issue が同一の番号空間を共有するため kind で分離されることが契約
  test("同一番号でも PR と issue は別キーになる", () => {
    const pr = makeTask({ id: "pr", ghRef: ghRefForPr(7) });
    const issue = makeTask({ id: "issue", ghRef: ghRefForIssue(7) });
    const index = buildTaskIndexByGhRef([makeWt([pr, issue])]);
    expect(index.get(ghRefKey(ghRefForPr(7)))?.id).toBe("pr");
    expect(index.get(ghRefKey(ghRefForIssue(7)))?.id).toBe("issue");
  });

  test("worktree 横断で index され、同一 ghRef は createdAt 最新を採用する", () => {
    const older = makeTask({
      id: "older",
      ghRef: ghRefForIssue(1),
      createdAt: "2026-07-15T01:49:28Z",
    });
    const newer = makeTask({
      id: "newer",
      ghRef: ghRefForIssue(1),
      createdAt: "2026-07-15T01:49:29Z",
    });
    const index = buildTaskIndexByGhRef([makeWt([newer]), makeWt([older])]);
    expect(index.get(ghRefKey(ghRefForIssue(1)))?.id).toBe("newer");
  });

  // createdAt は秒粒度で同点がありうる。反復順 (worktrees 配列順) に依存せず
  // id 辞書順で決定論的に倒れることが契約 (main 側 attachSession の pick と同じ)
  test("createdAt 同点は id 辞書順最大を採用し、反復順に依存しない", () => {
    const a = makeTask({ id: "a", ghRef: ghRefForIssue(1) });
    const b = makeTask({ id: "b", ghRef: ghRefForIssue(1) });
    expect(buildTaskIndexByGhRef([makeWt([a, b])]).get(ghRefKey(ghRefForIssue(1)))?.id).toBe("b");
    expect(buildTaskIndexByGhRef([makeWt([b, a])]).get(ghRefKey(ghRefForIssue(1)))?.id).toBe("b");
  });
});
