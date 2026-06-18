import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import { createClaudeStatusManager, type ClaudeStatus } from "./claudeStatus";

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
  test("pending work が無ければ done に遷移する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", {
      last_assistant_message: "完了しました。",
      pending_work: false,
    });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
  });

  test("pending_work が true なら done にせず working を維持する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", {
      last_assistant_message: "サブエージェントに投げました。",
      pending_work: true,
    });
    // background_tasks / session_crons が残る早期 Stop は真の done ではない
    expect(claudeStatusByPtyId.value[1]?.state).toBe("working");
  });
});
