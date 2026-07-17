import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import {
  classifyClaudeTitle,
  createClaudeStatusManager,
  displayClaudeState,
  isTeammateLifecycleId,
  screenHasClaudeBlocker,
  stripClaudeTitlePrefix,
  teammateIdMatchesName,
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

describe("teammate 台帳（subagent-start / subagent-stop / teammate-idle）", () => {
  // 実データ形状: teammate id は `a<name>-<hex>`、one-shot subagent id は `a<hex>`
  const TEAMMATE_ID = "apr-981-reviewer-90ed05bf5c651c85";
  const TEAMMATE_NAME = "pr-981-reviewer";
  const ONE_SHOT_ID = "a16e6e90f336247e8";

  test("teammate 稼働中の done は working 表示（pending_work=false でも）、fx は抑止", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    const fx = manager.handleHookEvent(1, "done", {
      pending_work: false,
      has_teammate_task: true,
    });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");
    expect(fx).toBeUndefined();
  });

  test("teammate-idle は in-flight 通知として扱い、lead が再稼働するまで done にしない", () => {
    // teammate の idle 化は必ず idle 通知を lead へ発射する。台帳が空になっても通知の
    // 消化（次のターン開始）までは系が静止していないため working 表示を維持する
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");

    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");

    // idle 通知が配送され lead が再稼働（新ターン開始）→ in-flight 消化
    manager.observeTitle(1, WORKING_TITLE);
    const fx = manager.handleHookEvent(1, "done", {
      last_assistant_message: "対応は不要です。",
      pending_work: false,
      has_teammate_task: true,
    });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
    expect(fx).toEqual({ ptyId: 1, event: "done", message: "対応は不要です。" });
  });

  test("しりとり終局シナリオ: lead 稼働中の idle 化 → 最初の Stop は鳴らず、消化後の Stop で 1 回だけ鳴る", () => {
    // 実測した二重通知: teammate が最終手を送って idle 化（通知が queue に滞留）→ lead の
    // 総括 Stop（ここで鳴ってしまっていた）→ 4ms 後に通知配送 → 応答 Stop（2 回目）
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE); // lead は最終ターン処理中
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });

    // Stop #1（総括）: in-flight 通知があるため真の done ではない → 鳴らさない
    const fx1 = manager.handleHookEvent(1, "done", {
      last_assistant_message: "10 語完走で引き分けです。",
      pending_work: false,
      has_teammate_task: true,
    });
    expect(fx1).toBeUndefined();
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");

    // 通知配送 → turn #2 開始（done → working 遷移で in-flight 消化）
    manager.observeTitle(1, WORKING_TITLE);
    // Stop #2: 系が静止 → 真の done、ここで 1 回だけ鳴る
    const fx2 = manager.handleHookEvent(1, "done", {
      last_assistant_message: "対応は不要です。",
      pending_work: false,
      has_teammate_task: true,
    });
    expect(fx2).toEqual({ ptyId: 1, event: "done", message: "対応は不要です。" });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("running（ユーザープロンプト）でも in-flight 通知を消化する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });
    manager.handleHookEvent(1, "running", {});
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("asking → working（承認後の同一ターン再開）では in-flight を消化しない", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash", tool_input: "{}" });
    await new Promise((r) => setTimeout(r, 200));
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    // lead が承認待ちの間に teammate が idle 化（通知は滞留）
    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });
    // 承認 → 同一ターン再開。ターン境界を跨いでいないので通知は未消化のまま
    manager.observeTitle(1, WORKING_TITLE);
    const fx = manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(fx).toBeUndefined();
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");
  });

  test("subagent-stop（shutdown 等の通知なし終了）は台帳から除去して done 表示に回復する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    manager.handleHookEvent(1, "subagent-stop", { agent_id: TEAMMATE_ID });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("one-shot subagent の id は台帳に載らない（length 判定 = pending_work が担う）", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "subagent-start", { agent_id: ONE_SHOT_ID });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    // 台帳は空（one-shot は載せない）ので teammate task が残っていても done
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("has_teammate_task=false の Stop は台帳と in-flight 通知の残留を掃除する（取りこぼし回復）", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });
    // teammate が shutdown され配列から消えた（idle 通知の配送は来なかった）
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: false });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
    // 掃除済みなので、以降 has_teammate_task=true の Stop が来ても phantom で working 化しない
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("teammatePending な done は clearDoneStates で idle に消化できる（固着しない）", () => {
    const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
    const manager = createClaudeStatusManager({
      claudeStatusByPtyId,
      panes: {
        getSessionPtyId: () => undefined,
        iteratePanes: () => [{ leafId: "leaf-1", dir: "/wt", ptyId: 1 }],
      },
      isPtyAlive: () => true,
    });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    manager.clearDoneStates("/wt");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });

  test("session-end で台帳が破棄され、次セッションを汚染しない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "session-end", { session_id: "s1" });

    manager.handleHookEvent(1, "session-start", { session_id: "s2" });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("isTeammateLifecycleId: teammate 形状（a<name>-<hex>）だけ true", () => {
    expect(isTeammateLifecycleId(TEAMMATE_ID)).toBe(true);
    expect(isTeammateLifecycleId(ONE_SHOT_ID)).toBe(false);
    expect(isTeammateLifecycleId("")).toBe(false);
    expect(isTeammateLifecycleId("no-a-prefix")).toBe(false);
  });

  test("teammateIdMatchesName: suffix にハイフンを許さず rev が rev-two に誤一致しない", () => {
    expect(teammateIdMatchesName("arev-90ed05bf", "rev")).toBe(true);
    expect(teammateIdMatchesName("arev-two-90ed05bf", "rev")).toBe(false);
    expect(teammateIdMatchesName("arev-two-90ed05bf", "rev-two")).toBe(true);
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

describe("screenHasClaudeBlocker（承認 UI の可視判定）", () => {
  test("承認プロンプトの文言（大小無視）を検出する", () => {
    expect(screenHasClaudeBlocker("Do you want to proceed?")).toBe(true);
    expect(screenHasClaudeBlocker("  2. No (esc to cancel)")).toBe(true);
    // 承認 UI の無い素のプロンプトは false
    expect(screenHasClaudeBlocker("❯ ")).toBe(false);
    expect(screenHasClaudeBlocker("some normal output line")).toBe(false);
  });

  // 選択 UI（AskUserQuestion 等）の footer 文言。誤離脱リスクが最も高い経路なので、
  // 各 marker が個別に有効であることを固定して、落とし / typo を回帰検出できるようにする
  test("選択 UI の footer 文言（enter to select / to navigate）を検出する", () => {
    expect(screenHasClaudeBlocker("↑/↓ to navigate · enter to select")).toBe(true);
    expect(screenHasClaudeBlocker("Press enter to select an option")).toBe(true);
    expect(screenHasClaudeBlocker("Use tab/arrow keys to navigate")).toBe(true);
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

  test("asking 中に承認 UI 文言が画面から消えたら idle に戻る（キャンセル / 中断）", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash", tool_input: "{}" });
    await new Promise((r) => setTimeout(r, 200));
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    // 承認プロンプト表示中は文言が画面にあるので asking を維持
    manager.observeScreen(1, () => "Do you want to proceed?\n❯ 1. Yes\n  2. No (esc to cancel)");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    // キャンセルで承認 UI が消えた画面 → idle に戻る
    manager.observeScreen(1, () => "❯ ");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });

  test("asking 離脱では lastActivityAt を維持する", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    const workingAt = claudeStatusByPtyId.value[1]?.lastActivityAt;
    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash", tool_input: "{}" });
    await new Promise((r) => setTimeout(r, 200));

    manager.observeScreen(1, () => "❯ ");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
    expect(claudeStatusByPtyId.value[1]?.lastActivityAt).toBe(workingAt);
  });

  test("asking 以外では画面本文を読まない（遅延取得を呼ばない）", () => {
    const { manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    // idle 状態
    let read = false;
    manager.observeScreen(1, () => {
      read = true;
      return "";
    });
    expect(read).toBe(false);
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
