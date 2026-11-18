import type { ClaudeTask } from "@gozd/rpc";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeTasks, selectCurrentGoal } from "./claudeTasks";

const SID = "11111111-2222-3333-4444-555555555555";
const TEAM_LIST = "session-11111111";

function task(id: string, goal: string, status: ClaudeTask["status"] = "pending"): ClaudeTask {
  return {
    id,
    subject: `step ${id}`,
    description: "",
    activeForm: "",
    status,
    blockedBy: [],
    goal,
  };
}

describe("readClaudeTasks", () => {
  const tempDirs: string[] = [];

  function makeTasksDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-claude-tasks-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeTask(tasksDir: string, name: string, content: unknown, list = SID): void {
    const dir = join(tasksDir, list);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("タスクを 1 件も作っていないセッションは空の一覧になる", () => {
    expect(readClaudeTasks(SID, makeTasksDir())).toEqual({ goal: "", tasks: [] });
  });

  test("Claude Code が書いた形のタスクを id の数値順に返す", () => {
    const tasksDir = makeTasksDir();
    for (const id of ["10", "2", "1"]) {
      writeTask(tasksDir, `${id}.json`, {
        id,
        subject: `step ${id}`,
        description: "do it",
        activeForm: "doing it",
        status: id === "1" ? "completed" : "pending",
        blocks: [],
        blockedBy: id === "10" ? ["2"] : [],
        metadata: { goal: "ship it" },
      });
    }
    writeTask(tasksDir, ".lock", "");
    const { goal, tasks } = readClaudeTasks(SID, tasksDir);
    expect(goal).toBe("ship it");
    expect(tasks.map((entry) => entry.id)).toEqual(["1", "2", "10"]);
    expect(tasks[0]).toEqual({
      id: "1",
      subject: "step 1",
      description: "do it",
      activeForm: "doing it",
      status: "completed",
      blockedBy: [],
      goal: "ship it",
    });
    expect(tasks[2]?.blockedBy).toEqual(["2"]);
  });

  test("壊れたファイルと知らない状態のタスクは一覧から外し、残りは返す", () => {
    const tasksDir = makeTasksDir();
    writeTask(tasksDir, "1.json", { id: "1", subject: "ok", status: "in_progress" });
    writeTask(tasksDir, "2.json", "{ broken");
    writeTask(tasksDir, "3.json", { id: "3", subject: "future", status: "archived" });
    expect(readClaudeTasks(SID, tasksDir).tasks.map((entry) => entry.id)).toEqual(["1"]);
  });

  test("読めないファイルは一覧から外し、残りは返す", () => {
    const tasksDir = makeTasksDir();
    writeTask(tasksDir, "1.json", { id: "1", subject: "ok", status: "pending" });
    // ディレクトリは .json で終わっていても読めない（EISDIR）
    mkdirSync(join(tasksDir, SID, "2.json"));
    expect(readClaudeTasks(SID, tasksDir).tasks.map((entry) => entry.id)).toEqual(["1"]);
  });

  test("Agent Teams を率いるセッションは、チーム名の一覧を読む", () => {
    const tasksDir = makeTasksDir();
    writeTask(tasksDir, "1.json", { id: "1", subject: "lead", status: "pending" }, TEAM_LIST);
    expect(readClaudeTasks(SID, tasksDir).tasks.map((entry) => entry.subject)).toEqual(["lead"]);
  });

  test("セッション ID の一覧とチーム名の一覧が両方あれば、新しく書かれた方を読む", () => {
    const tasksDir = makeTasksDir();
    writeTask(tasksDir, "1.json", { id: "1", subject: "solo", status: "pending" });
    writeTask(tasksDir, "1.json", { id: "1", subject: "lead", status: "pending" }, TEAM_LIST);
    utimesSync(join(tasksDir, SID), new Date(1000), new Date(1000));
    expect(readClaudeTasks(SID, tasksDir).tasks[0]?.subject).toBe("lead");
    utimesSync(join(tasksDir, TEAM_LIST), new Date(500), new Date(500));
    expect(readClaudeTasks(SID, tasksDir).tasks[0]?.subject).toBe("solo");
  });

  test("パスを抜け出すセッション ID は拒否する", () => {
    expect(() => readClaudeTasks("../etc", makeTasksDir())).toThrow("invalid sessionId");
  });
});

describe("selectCurrentGoal", () => {
  test("目的が 1 件も無ければ全件を返す", () => {
    const tasks = [task("1", ""), task("2", "")];
    expect(selectCurrentGoal(tasks)).toEqual({ goal: "", tasks });
  });

  test("最も新しい目的を選び、前の目的のタスクを外す", () => {
    const tasks = [task("1", "consult", "completed"), task("2", "build"), task("3", "build")];
    const selected = selectCurrentGoal(tasks);
    expect(selected.goal).toBe("build");
    expect(selected.tasks.map((entry) => entry.id)).toEqual(["2", "3"]);
  });

  test("目的を付け忘れたタスクは、今の目的の最初のタスクより後にあるときだけ残す", () => {
    const tasks = [task("1", ""), task("2", "build"), task("3", "")];
    expect(selectCurrentGoal(tasks).tasks.map((entry) => entry.id)).toEqual(["2", "3"]);
  });
});
