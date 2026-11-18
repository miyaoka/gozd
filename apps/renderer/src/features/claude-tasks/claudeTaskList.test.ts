import type { ClaudeTask } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { EMPTY_TASK_LIST, isBlocked, mergeTaskList, taskListHeadline } from "./claudeTaskList";

function task(id: string, status: ClaudeTask["status"], extra: Partial<ClaudeTask> = {}) {
  return {
    id,
    subject: `step ${id}`,
    description: "",
    activeForm: "",
    status,
    blockedBy: [],
    goal: "",
    ...extra,
  } satisfies ClaudeTask;
}

describe("mergeTaskList", () => {
  const done = { goal: "ship", tasks: [task("1", "completed"), task("2", "completed")] };

  test("全件完了の一覧が片付けられて空になっても、完了した一覧を残す", () => {
    expect(mergeTaskList(done, EMPTY_TASK_LIST)).toBe(done);
  });

  test("未完了が残る一覧が空になったら、空にする（タスクを消した）", () => {
    const open = { goal: "ship", tasks: [task("1", "completed"), task("2", "pending")] };
    expect(mergeTaskList(open, EMPTY_TASK_LIST)).toBe(EMPTY_TASK_LIST);
  });

  test("完了した一覧の後に新しいタスクが作られたら、新しい一覧にする", () => {
    const next = { goal: "next", tasks: [task("3", "pending")] };
    expect(mergeTaskList(done, next)).toBe(next);
  });
});

describe("taskListHeadline", () => {
  test("目的があれば目的を見出しにする", () => {
    expect(taskListHeadline({ goal: "ship", tasks: [task("1", "in_progress")] })).toBe("ship");
  });

  test("目的が無ければ実行中の手順の文言で代える", () => {
    const list = { goal: "", tasks: [task("1", "in_progress", { activeForm: "shipping" })] };
    expect(taskListHeadline(list)).toBe("shipping");
  });
});

describe("isBlocked", () => {
  test("未完了の依存先が残るときだけ待ちにする", () => {
    const waiting = task("2", "pending", { blockedBy: ["1"] });
    expect(isBlocked(waiting, [task("1", "pending"), waiting])).toBe(true);
    expect(isBlocked(waiting, [task("1", "completed"), waiting])).toBe(false);
  });
});
