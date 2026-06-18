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
  test("pending work が無ければ done になり displayClaudeState も done。fx も発行される", () => {
    const { claudeStatusByPtyId, manager } = setup();
    const fx = manager.handleHookEvent(1, "done", {
      last_assistant_message: "完了しました。",
      pending_work: false,
    });
    const status = claudeStatusByPtyId.value[1];
    expect(status?.state).toBe("done");
    expect(displayClaudeState(status)).toBe("done");
    // 真の done は効果ストリームに流す（音・演出・読み上げが出る）
    expect(fx).toEqual({ ptyId: 1, event: "done", message: "完了しました。" });
  });

  test("pending work があっても state は done に倒し、displayClaudeState だけ working。fx は発行しない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    const fx = manager.handleHookEvent(1, "done", {
      last_assistant_message: "サブエージェントに投げました。",
      pending_work: true,
    });
    const status = claudeStatusByPtyId.value[1];
    // 状態機械は done を経由する（clearDoneStates で消化可能・固着しない）
    expect(status?.state).toBe("done");
    expect(status?.state === "done" && status.pendingWork).toBe(true);
    // 表示だけ working に倒し、緑バッジを抑止する
    expect(displayClaudeState(status)).toBe("working");
    // 効果の抑止はここ 1 箇所。fx を発行しないので音・演出・読み上げは購読側に届かない
    expect(fx).toBeUndefined();
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

describe("handleHookEvent fx 発行（効果ストリームの単一発行点）", () => {
  test("running / tool-done / needs-input / stop-failure は fx を発行する", () => {
    const { manager } = setup();
    expect(manager.handleHookEvent(1, "running", {})).toEqual({ ptyId: 1, event: "running" });
    // tool-done は working 中のみ（done 中の遅延は無視）
    expect(manager.handleHookEvent(1, "tool-done", {})).toEqual({ ptyId: 1, event: "tool-done" });
    // 本番では tool_input は JSON 文字列で届く（proto3 string）。boundary で 1 度 parse して
    // 構造化オブジェクトとして fx に載ることを検証する。
    expect(
      manager.handleHookEvent(1, "needs-input", {
        tool_name: "Bash",
        tool_input: '{"command":"ls"}',
      }),
    ).toEqual({ ptyId: 1, event: "needs-input", toolName: "Bash", toolInput: { command: "ls" } });
    expect(
      manager.handleHookEvent(1, "stop-failure", { last_assistant_message: "API error" }),
    ).toEqual({ ptyId: 1, event: "stop-failure", message: "API error" });
  });

  test("needs-input の tool_input が壊れた JSON 文字列でも throw せず toolInput は undefined", () => {
    const { manager } = setup();
    const fx = manager.handleHookEvent(1, "needs-input", {
      tool_name: "Bash",
      tool_input: "{not json",
    });
    expect(fx).toEqual({ ptyId: 1, event: "needs-input", toolName: "Bash", toolInput: undefined });
  });

  test("dead PTY への hook は fx を発行しない", () => {
    const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
    const manager = createClaudeStatusManager({
      claudeStatusByPtyId,
      panes: { getSessionPtyId: () => undefined, iteratePanes: () => [] },
      isPtyAlive: () => false,
    });
    expect(manager.handleHookEvent(1, "done", { pending_work: false })).toBeUndefined();
  });

  test("done 後の遅延 tool-done は state も fx も変えない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "done", { pending_work: false });
    const lateFx = manager.handleHookEvent(1, "tool-done", {});
    expect(lateFx).toBeUndefined();
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
  });
});
