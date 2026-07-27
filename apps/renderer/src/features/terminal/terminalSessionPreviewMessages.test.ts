import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../session-log";
import type { PreviewEvent } from "./terminalSessionPreviewMessages";
import { collectMessages, countInProgressActions } from "./terminalSessionPreviewMessages";

// "u1" → user, "a3" → assistant のように先頭文字で kind を決め、ラベルを text に入れる。
// ts は出現順の連番 (順序は ts に依存しない設計だが、実ログ同様に昇順で振っておく)
function ev(label: string, index: number): PreviewEvent {
  return {
    kind: label.startsWith("u") ? "user" : "assistant",
    text: label,
    ts: `2026-06-12T00:00:${String(index).padStart(2, "0")}Z`,
  };
}

function events(...labels: string[]): PreviewEvent[] {
  return labels.map((label, i) => ev(label, i));
}

function texts(input: PreviewEvent[]): string[] {
  return collectMessages(input).map((m) => m.text);
}

describe("collectMessages", () => {
  test("代表例: 各 run は最終発言で代表し、応答中の assistant run だけ末尾 3 件展開する", () => {
    const input = events(
      "u1",
      "a",
      "a",
      "a",
      "a1",
      "u",
      "u2",
      "a",
      "a2",
      "u3",
      "a",
      "a3-1",
      "a3-2",
      "a3-3",
    );
    expect(texts(input)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3-1", "a3-2", "a3-3"]);
  });

  test("空配列 → 空", () => {
    expect(texts([])).toEqual([]);
  });

  test("最後が user run のとき、assistant run は展開せず 1 件代表に畳む", () => {
    const input = events("u1", "a", "a1-1", "a1-2", "u2");
    expect(texts(input)).toEqual(["u1", "a1-2", "u2"]);
  });

  test("user が最新なら、直前の連続 assistant 応答も代表 1 件になる", () => {
    const input = events("u1", "a1", "u2", "a2-1", "a2-2", "a2-3", "u3");
    expect(texts(input)).toEqual(["u1", "a1", "u2", "a2-3", "u3"]);
  });

  test("空文字 event を挟んだ同 kind 連続は 1 run に束ねられる (run 分断しない)", () => {
    const input = [
      ev("u1", 0),
      ev("a1-1", 1),
      { kind: "user" as const, text: "", ts: "2026-06-12T00:00:02Z" },
      ev("a1-2", 2),
      ev("a1-3", 3),
      ev("a1-4", 4),
    ];
    // 空 user で分断されると assistant run が 2 つに割れ a1-1 が代表化されてしまう。
    // 1 run に束ねられていれば末尾 3 件展開で a1-2..a1-4 が出る
    expect(texts(input)).toEqual(["u1", "a1-2", "a1-3", "a1-4"]);
  });

  test("run が 4 個以上ある kind は最古 run が drop される", () => {
    const input = events("u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4");
    expect(texts(input)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);
  });

  test("assistant 発言のみのログでも最新 run の末尾 3 件が出る", () => {
    const input = events("a1", "a2", "a3", "a4");
    expect(texts(input)).toEqual(["a2", "a3", "a4"]);
  });
});

describe("countInProgressActions", () => {
  const tool: TranscriptEvent = {
    kind: "tool",
    name: "Bash",
    input: {},
    toolUseId: "t1",
    ts: "2026-06-12T00:00:00Z",
    result: undefined,
  };
  const thinking: TranscriptEvent = { kind: "thinking", text: "...", ts: "2026-06-12T00:00:00Z" };
  const assistant: TranscriptEvent = {
    kind: "assistant",
    text: "done",
    ts: "2026-06-12T00:00:00Z",
  };
  const user: TranscriptEvent = { kind: "user", text: "hi", ts: "2026-06-12T00:00:00Z" };

  test("末尾が tool なら進行中 (1 件)", () => {
    expect(countInProgressActions([user, tool])).toBe(1);
  });

  test("末尾が thinking なら進行中 (1 件)", () => {
    expect(countInProgressActions([user, assistant, thinking])).toBe(1);
  });

  test("直近の発言以降の thinking / tool をすべて数える", () => {
    expect(countInProgressActions([user, thinking, tool, tool, thinking, tool])).toBe(5);
  });

  test("発言をまたいだ手前のアクションは数えない", () => {
    expect(countInProgressActions([user, tool, tool, assistant, tool])).toBe(1);
  });

  test("末尾が assistant (発言) ならリセットされる", () => {
    expect(countInProgressActions([user, tool, assistant])).toBe(0);
  });

  test("末尾が user (発言) ならリセットされる", () => {
    expect(countInProgressActions([assistant, tool, user])).toBe(0);
  });

  test("空配列は進行中でない", () => {
    expect(countInProgressActions([])).toBe(0);
  });

  const system: TranscriptEvent = {
    kind: "system",
    label: "PreToolUse:Bash",
    text: "injected",
    ts: "2026-06-12T00:00:00Z",
  };

  // system (注入) はエージェントのアクションでも発言でもないため透過する (件数にも数えない)。
  // tool 実行中に hook 注入が末尾に来た瞬間 (tool_result 到着前) に進行中表示を消さない。
  test("system を透過して直近の tool を数える (system 自体は数えない)", () => {
    expect(countInProgressActions([user, tool, system, tool, system])).toBe(2);
  });

  test("末尾の system を透過して直近の assistant (発言) でリセットされる", () => {
    expect(countInProgressActions([user, assistant, system])).toBe(0);
  });

  test("system のみの列は進行中でない", () => {
    expect(countInProgressActions([system])).toBe(0);
  });

  const image: TranscriptEvent = { kind: "image", ts: "2026-06-12T00:00:00Z", source: undefined };
  const emptyAssistant: TranscriptEvent = {
    kind: "assistant",
    text: "",
    ts: "2026-06-12T00:00:00Z",
  };

  // image / 空文字発言は preview の bubble に出ない。打ち切ると画面に何も現れないまま
  // 点の数が巻き戻るため透過する。
  test("image を透過してアクションを数え続ける", () => {
    expect(countInProgressActions([user, tool, image, tool])).toBe(2);
  });

  test("空文字の assistant を透過してアクションを数え続ける", () => {
    expect(countInProgressActions([user, tool, emptyAssistant, tool])).toBe(2);
  });

  test("末尾が image でも直近のアクション件数を返す", () => {
    expect(countInProgressActions([user, tool, tool, image])).toBe(2);
  });
});
