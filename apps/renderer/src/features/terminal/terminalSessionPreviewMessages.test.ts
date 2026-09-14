import { describe, expect, test } from "bun:test";
import { speechesOf, type Speech, type TranscriptEvent } from "../session-log";
import { collectMessages, countInProgressActions } from "./terminalSessionPreviewMessages";

// "u1" → user, "a3" → assistant のように先頭文字で話者を決め、ラベルを text に入れる。
// ts は出現順の連番 (順序は ts に依存しない設計だが、実ログ同様に昇順で振っておく)
function speech(label: string, index: number): Speech {
  return {
    speaker: label.startsWith("u") ? "user" : "assistant",
    text: label,
    mark: undefined,
    ts: `2026-06-12T00:00:${String(index).padStart(2, "0")}Z`,
  };
}

function speeches(...labels: string[]): Speech[] {
  return labels.map((label, i) => speech(label, i));
}

function texts(input: Speech[]): string[] {
  return collectMessages(input).map((m) => m.text);
}

describe("collectMessages", () => {
  test("代表例: 各 run は最終発言で代表し、応答中の assistant run だけ末尾 3 件展開する", () => {
    const input = speeches(
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
    const input = speeches("u1", "a", "a1-1", "a1-2", "u2");
    expect(texts(input)).toEqual(["u1", "a1-2", "u2"]);
  });

  test("user が最新なら、直前の連続 assistant 応答も代表 1 件になる", () => {
    const input = speeches("u1", "a1", "u2", "a2-1", "a2-2", "a2-3", "u3");
    expect(texts(input)).toEqual(["u1", "a1", "u2", "a2-3", "u3"]);
  });

  test("run が 4 個以上ある話者は最古 run が drop される", () => {
    const input = speeches("u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4");
    expect(texts(input)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);
  });

  test("assistant 発言のみのログでも最新 run の末尾 3 件が出る", () => {
    const input = speeches("a1", "a2", "a3", "a4");
    expect(texts(input)).toEqual(["a2", "a3", "a4"]);
  });

  // 空文字の発言は発言にならないため、挟まっても同じ話者の連続は 1 run に束ねられる。
  // 空 user で分断されると assistant run が 2 つに割れ a1-1 が代表化されてしまう
  test("空文字の発言を挟んだ同じ話者の連続は 1 run に束ねられる", () => {
    const ts = "2026-06-12T00:00:00Z";
    const events: TranscriptEvent[] = [
      { kind: "user", text: "u1", ts },
      { kind: "assistant", text: "a1-1", ts },
      { kind: "user", text: "", ts },
      { kind: "assistant", text: "a1-2", ts },
      { kind: "assistant", text: "a1-3", ts },
      { kind: "assistant", text: "a1-4", ts },
    ];
    expect(texts(events.flatMap(speechesOf))).toEqual(["u1", "a1-2", "a1-3", "a1-4"]);
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

  // thinking は assistant の発言として吹き出しに出るため、発言と同じくリセットする。
  test("末尾が thinking (発言) ならリセットされる", () => {
    expect(countInProgressActions([user, tool, thinking])).toBe(0);
  });

  test("直近の発言以降の tool をすべて数え、thinking で打ち切る", () => {
    expect(countInProgressActions([user, tool, thinking, tool, tool, tool])).toBe(3);
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

  // 質問ツールは質問と回答の吹き出しになるため、発言と同じくリセットする。
  test("末尾が質問ツールならリセットされる", () => {
    const ask: TranscriptEvent = {
      kind: "ask",
      ts: "2026-06-12T00:00:00Z",
      toolUseId: "tu1",
      questions: [
        { question: "Q", header: "", multiSelect: false, options: [], answer: undefined },
      ],
    };
    expect(countInProgressActions([user, tool, ask])).toBe(0);
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
