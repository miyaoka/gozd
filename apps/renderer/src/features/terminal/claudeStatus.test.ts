import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import { createClaudeStatusManager, displayClaudeState, type ClaudeStatus } from "./claudeStatus";

function setup() {
  const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
  const manager = createClaudeStatusManager({
    claudeStatusByPtyId,
    panes: {
      getSessionPtyId: () => undefined,
      iteratePanes: () => [],
    },
    isPtyAlive: () => true,
  });
  return { claudeStatusByPtyId, manager };
}

describe("handleHookEvent done", () => {
  test("pending work が無ければ done になり displayClaudeState も done", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", {
      last_assistant_message: "完了しました。",
      pending_work: false,
    });
    const status = claudeStatusByPtyId.value[1];
    expect(status?.state).toBe("done");
    expect(displayClaudeState(status)).toBe("done");
  });

  test("pending work があっても state は done に倒し、displayClaudeState だけ working にする", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", {
      last_assistant_message: "サブエージェントに投げました。",
      pending_work: true,
    });
    const status = claudeStatusByPtyId.value[1];
    // 状態機械は done を経由する（clearDoneStates で消化可能・固着しない）
    expect(status?.state).toBe("done");
    expect(status?.state === "done" && status.pendingWork).toBe(true);
    // 表示だけ working に倒し、緑バッジ・通知を抑止する
    expect(displayClaudeState(status)).toBe("working");
  });

  test("pending な done のあと pending なし done が来たら displayClaudeState が working → done に回復する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", { pending_work: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");
    manager.handleHookEvent(1, "done", {
      last_assistant_message: "全部終わりました。",
      pending_work: false,
    });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("pending な done は clearDoneStates で idle に消化できる（固着しない）", () => {
    const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
    const manager = createClaudeStatusManager({
      claudeStatusByPtyId,
      panes: {
        getSessionPtyId: () => undefined,
        iteratePanes: () => [{ leafId: "leaf-1", dir: "/wt", ptyId: 1 }],
      },
      isPtyAlive: () => true,
    });
    manager.handleHookEvent(1, "done", { pending_work: true });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
    manager.clearDoneStates("/wt");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });
});
