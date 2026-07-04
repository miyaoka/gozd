import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import {
  classifyClaudeTitle,
  createClaudeStatusManager,
  displayClaudeState,
  stripClaudeTitlePrefix,
  type ClaudeStatus,
} from "./claudeStatus";

/** Claude が OSC タイトル先頭に出すプレフィックス（点字スピナー / ✳ + スペース） */
const WORKING_TITLE = "⠋ project"; // U+280B = 点字スピナーの一種
const IDLE_TITLE = "✳ project"; // U+2733 = ✳

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
    // 本番では tool_input は JSON 文字列で届く（HookMessage.toolInput 契約）。boundary で 1 度 parse して
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

describe("classifyClaudeTitle / stripClaudeTitlePrefix", () => {
  test("スピナープレフィックスは working、✳ は idle、それ以外は undefined", () => {
    expect(classifyClaudeTitle(WORKING_TITLE)).toBe("working");
    expect(classifyClaudeTitle(IDLE_TITLE)).toBe("idle");
    expect(classifyClaudeTitle("plain title")).toBeUndefined();
    // 矢印キー等のエスケープではなく通常タイトル。プレフィックス無しは状態シグナル無し
    expect(classifyClaudeTitle("⠋no-space")).toBeUndefined();
  });

  test("strip は working/idle 両プレフィックスを落とし、素のタイトルは触らない", () => {
    expect(stripClaudeTitlePrefix(WORKING_TITLE)).toBe("project");
    expect(stripClaudeTitlePrefix(IDLE_TITLE)).toBe("project");
    expect(stripClaudeTitlePrefix("project")).toBe("project");
  });
});

describe("observeTitle（OSC タイトル駆動の状態）", () => {
  test("session 確立後: スピナー → working、✳ → idle。idle は lastActivityAt 維持", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });

    manager.observeTitle(1, WORKING_TITLE);
    const working = claudeStatusByPtyId.value[1];
    expect(working?.state).toBe("working");

    manager.observeTitle(1, IDLE_TITLE);
    const idle = claudeStatusByPtyId.value[1];
    expect(idle?.state).toBe("idle");
    // idle 化は Claude の活動ではないため working の lastActivityAt を持ち越す
    expect(idle?.lastActivityAt).toBe(working?.lastActivityAt);
  });

  test("session 未確立（session-start 前）はタイトルから状態を作らない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.observeTitle(1, WORKING_TITLE);
    expect(claudeStatusByPtyId.value[1]).toBeUndefined();
  });

  test("✳ は done を上書きしない（未読 done を消さない）", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "done", { pending_work: false });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
    // Stop 直後に Claude はプロンプト待ちタイトル ✳ を出すが、done は温存する
    manager.observeTitle(1, IDLE_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
  });

  test("✳ は asking を上書きしない（hook 権威を温存）", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash", tool_input: "{}" });
    // needs-input は 150ms debounce 後に asking へ遷移する
    await new Promise((r) => setTimeout(r, 200));
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    manager.observeTitle(1, IDLE_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");
  });

  test("asking 中にスピナーが来ると working に復帰する（承認後の再開）", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash", tool_input: "{}" });
    await new Promise((r) => setTimeout(r, 200));
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    manager.observeTitle(1, WORKING_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("working");
  });

  test("done 中でもスピナー（新ターン開始）は working にする", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "done", { pending_work: false });
    manager.observeTitle(1, WORKING_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("working");
  });

  test("プレフィックスの無いタイトルは状態を変えない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, "plain title");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });
});

describe("running / tool-done は状態を駆動しない（状態は title 専任）", () => {
  test("running / tool-done は fx を返すが state は変えない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");

    // fx は従来どおり発行される（arcade engage / tick）
    expect(manager.handleHookEvent(1, "running", {})).toEqual({ ptyId: 1, event: "running" });
    expect(manager.handleHookEvent(1, "tool-done", {})).toEqual({ ptyId: 1, event: "tool-done" });
    // しかし状態は idle のまま（working 化は title のみが行う）
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });
});
