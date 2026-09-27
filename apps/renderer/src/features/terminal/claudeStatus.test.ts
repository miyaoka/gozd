import { describe, expect, test } from "bun:test";
import { ref, watch } from "vue";
import {
  classifyClaudeTitle,
  createClaudeStatusManager,
  displayClaudeState,
  isTeammateLifecycleId,
  screenHasClaudeBlocker,
  teammateIdMatchesName,
  type ClaudeStatus,
} from "./claudeStatus";

/** Claude が OSC タイトル先頭に出すプレフィックス（スピナー / ✳ + スペース） */
const WORKING_TITLE = "⠋ project"; // U+280B = 2.1.227 以前の点字スピナー
const WORKING_TITLE_HALF_CIRCLE = "◐ project"; // U+25D0 = 2.1.228 以降の半円スピナー
const WORKING_TITLE_HALF_CIRCLE_ALT = "◑ project"; // U+25D1 = 半円スピナーのもう 1 コマ
const IDLE_TITLE = "✳ project"; // U+2733 = ✳

/** Date.now() が返し得ない過去の時刻。遷移で最終更新が刻み直されたか / 維持されたかを見分ける */
const STALE_ACTIVITY_AT = 1;

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

/** 遷移前の状態を状態の ref に直接置く */
function seedStatus(
  claudeStatusByPtyId: ReturnType<typeof setup>["claudeStatusByPtyId"],
  ptyId: number,
  status: ClaudeStatus,
) {
  claudeStatusByPtyId.value[ptyId] = status;
}

/**
 * asking への進入は needs-input の debounce タイマーが担う。ここでは進入後の遷移を見るため、
 * タイマーが書くのと同じ形の asking を直接置く
 */
function enterAsking(
  claudeStatusByPtyId: ReturnType<typeof setup>["claudeStatusByPtyId"],
  ptyId: number,
) {
  seedStatus(claudeStatusByPtyId, ptyId, {
    state: "asking",
    lastActivityAt: STALE_ACTIVITY_AT,
    toolName: "Bash",
  });
}

describe("handleHookEvent done", () => {
  test("pending work があっても state は done に倒し、displayClaudeState だけ working。fx は発行しない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    const fx = manager.handleHookEvent(1, "done", {
      last_assistant_message: "サブエージェントに投げました。",
      pending_work: true,
    });
    const status = claudeStatusByPtyId.value[1];
    // 状態機械は done を経由する（clearDoneState で消化可能・固着しない）
    expect(status?.state).toBe("done");
    expect(status?.state === "done" && status.pendingWork).toBe(true);
    // 表示だけ working に倒し、緑バッジを抑止する
    expect(displayClaudeState(status)).toBe("working");
    // 効果の抑止はここ 1 箇所。fx を発行しないので音・演出・読み上げは購読側に届かない
    expect(fx).toBeUndefined();
  });

  test("pending な done は clearDoneState で idle に消化できる（固着しない）", () => {
    const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
    const manager = createClaudeStatusManager({
      claudeStatusByPtyId,
      panes: {
        getSessionPtyId: (leafId) => (leafId === "leaf-1" ? 1 : undefined),
        iteratePanes: () => [{ leafId: "leaf-1", dir: "/wt", ptyId: 1 }],
      },
      isPtyAlive: () => true,
    });
    manager.handleHookEvent(1, "done", { pending_work: true });
    expect(claudeStatusByPtyId.value[1]?.state).toBe("done");
    manager.clearDoneState("leaf-1");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
  });
});

describe("clearDoneState", () => {
  test("消化するのは指定した端末の done だけで、同じ dir の他の端末の done は未読のまま残る", () => {
    const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});
    const ptyIdByLeafId: Record<string, number> = { "leaf-1": 1, "leaf-2": 2 };
    const manager = createClaudeStatusManager({
      claudeStatusByPtyId,
      panes: {
        getSessionPtyId: (leafId) => ptyIdByLeafId[leafId],
        iteratePanes: () => [
          { leafId: "leaf-1", dir: "/wt", ptyId: 1 },
          { leafId: "leaf-2", dir: "/wt", ptyId: 2 },
        ],
      },
      isPtyAlive: () => true,
    });
    manager.handleHookEvent(1, "done", { pending_work: false });
    manager.handleHookEvent(2, "done", { pending_work: false });
    manager.clearDoneState("leaf-1");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
    expect(claudeStatusByPtyId.value[2]?.state).toBe("done");
  });
});

describe("teammate 台帳（subagent-start / subagent-stop / teammate-idle）", () => {
  // 実データ形状: teammate id は `a<name>-<hex>`、one-shot subagent id は `a<hex>`
  const TEAMMATE_ID = "apr-981-reviewer-90ed05bf5c651c85";
  const TEAMMATE_NAME = "pr-981-reviewer";
  const ONE_SHOT_ID = "a16e6e90f336247e8";

  test("teammate-idle は in-flight 通知として扱い、lead が再稼働するまで done にしない", () => {
    // teammate の idle 化は必ず idle 通知を lead へ発射する。台帳が空になっても通知の
    // 消化（次のターン開始）まではシステム全体が静止していないため working 表示を維持する
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
    // Stop #2: システム全体が静止 → 真の done、ここで 1 回だけ鳴る
    const fx2 = manager.handleHookEvent(1, "done", {
      last_assistant_message: "対応は不要です。",
      pending_work: false,
      has_teammate_task: true,
    });
    expect(fx2).toEqual({ ptyId: 1, event: "done", message: "対応は不要です。" });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("asking → working（承認後の同一ターン再開）では in-flight を消化しない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.observeTitle(1, WORKING_TITLE);
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    enterAsking(claudeStatusByPtyId, 1);

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

  test("session-end で台帳が破棄され、次セッションを汚染しない", () => {
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "session-end", { session_id: "s1" });

    manager.handleHookEvent(1, "session-start", { session_id: "s2" });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("session-end なしの sessionId 置換（/clear・/resume）でも台帳と in-flight を破棄する", () => {
    // /clear や --resume では旧セッションの session-end が発火しない（socketMessages.ts）。
    // 旧セッションの teammate 残留が新セッションの done を抑止しないこと。
    // 台帳（稼働中 teammate）と in-flight（配送待ち通知）の両方が残った状態で切り替える:
    // 2 体 spawn して片方だけ idle 化すると、台帳に生存 1 件 + in-flight true になる
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });
    manager.handleHookEvent(1, "subagent-start", { agent_id: "areviewer-b-11aa22bb" });
    manager.handleHookEvent(1, "teammate-idle", { teammate_name: TEAMMATE_NAME });

    manager.handleHookEvent(1, "session-start", { session_id: "s2" });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("done");
  });

  test("同一 sessionId の session-start（compact 由来）では台帳を保持する", () => {
    // compact では in-process teammate が生存するため、稼働中 teammate の追跡を失わないこと
    const { claudeStatusByPtyId, manager } = setup();
    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "subagent-start", { agent_id: TEAMMATE_ID });

    manager.handleHookEvent(1, "session-start", { session_id: "s1" });
    manager.handleHookEvent(1, "done", { pending_work: false, has_teammate_task: true });
    expect(displayClaudeState(claudeStatusByPtyId.value[1])).toBe("working");
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

describe("classifyClaudeTitle", () => {
  test("スピナープレフィックスは working、✳ は idle、それ以外は undefined", () => {
    // 点字・半円のどちらの字形でも working。利用者の Claude Code バージョンは選べない
    expect(classifyClaudeTitle(WORKING_TITLE)).toBe("working");
    expect(classifyClaudeTitle(WORKING_TITLE_HALF_CIRCLE)).toBe("working");
    expect(classifyClaudeTitle(WORKING_TITLE_HALF_CIRCLE_ALT)).toBe("working");
    expect(classifyClaudeTitle(IDLE_TITLE)).toBe("idle");
    expect(classifyClaudeTitle("plain title")).toBeUndefined();
    // 矢印キー等のエスケープではなく通常タイトル。プレフィックス無しは状態シグナル無し
    expect(classifyClaudeTitle("⠋no-space")).toBeUndefined();
    expect(classifyClaudeTitle("◐no-space")).toBeUndefined();
    // タイトルに出る半円は 2 コマだけ。範囲記法 `◐-◓` への一般化で残り 2 つを巻き込まない
    expect(classifyClaudeTitle("◒ project")).toBeUndefined();
    expect(classifyClaudeTitle("◓ project")).toBeUndefined();
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

describe("needs-input（承認待ちへの遷移）", () => {
  // 刻み忘れても表示は崩れず、サイドバーの並び順と相対時刻だけが黙ってずれる
  test("承認待ちに入った時刻を最終更新として刻む", async () => {
    const { claudeStatusByPtyId, manager } = setup();
    seedStatus(claudeStatusByPtyId, 1, { state: "working", lastActivityAt: STALE_ACTIVITY_AT });
    // 承認待ちへの遷移は debounce の先で状態の ref に書かれる。その書き込みを同期点にする
    const asking = new Promise<ClaudeStatus>((resolve) => {
      const stop = watch(
        claudeStatusByPtyId,
        (statuses) => {
          const status = statuses[1];
          if (status?.state !== "asking") return;
          stop();
          resolve(status);
        },
        { deep: true, flush: "sync" },
      );
    });

    manager.handleHookEvent(1, "needs-input", { tool_name: "Bash" });

    expect((await asking).lastActivityAt).toBeGreaterThan(STALE_ACTIVITY_AT);
  });
});

describe("observeTitle / observeScreen（タイトルと画面本文による遷移）", () => {
  test("working から ✳ で idle に抜けた時刻を最終更新として刻む", () => {
    const { claudeStatusByPtyId, manager } = setup();
    seedStatus(claudeStatusByPtyId, 1, { state: "working", lastActivityAt: STALE_ACTIVITY_AT });

    // 中断を含め、working を抜けた時点が Claude の最終更新になる
    manager.observeTitle(1, IDLE_TITLE);
    const idle = claudeStatusByPtyId.value[1];
    expect(idle?.state).toBe("idle");
    expect(idle?.lastActivityAt).toBeGreaterThan(STALE_ACTIVITY_AT);
  });

  test("✳ は asking を上書きしない（hook 権威を温存）", () => {
    const { claudeStatusByPtyId, manager } = setup();
    enterAsking(claudeStatusByPtyId, 1);
    manager.observeTitle(1, IDLE_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");
  });

  test("asking 中にスピナーが来ると working に復帰する（承認後の再開）", () => {
    const { claudeStatusByPtyId, manager } = setup();
    enterAsking(claudeStatusByPtyId, 1);
    manager.observeTitle(1, WORKING_TITLE);
    expect(claudeStatusByPtyId.value[1]?.state).toBe("working");
  });

  test("asking 中に承認 UI 文言が画面から消えたら idle に戻り、最終更新は asking の時刻を維持する", () => {
    const { claudeStatusByPtyId, manager } = setup();
    enterAsking(claudeStatusByPtyId, 1);

    // 承認プロンプト表示中は文言が画面にあるので asking を維持
    manager.observeScreen(1, () => "Do you want to proceed?\n❯ 1. Yes\n  2. No (esc to cancel)");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("asking");

    // キャンセルで承認 UI が消えた画面 → idle に戻る。キャンセルは人の操作で Claude の活動では
    // ないので、asking の時刻を持ち越す
    manager.observeScreen(1, () => "❯ ");
    expect(claudeStatusByPtyId.value[1]?.state).toBe("idle");
    expect(claudeStatusByPtyId.value[1]?.lastActivityAt).toBe(STALE_ACTIVITY_AT);
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
});
