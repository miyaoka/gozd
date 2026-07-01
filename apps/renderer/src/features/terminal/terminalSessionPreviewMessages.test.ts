import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../session-log";
import type { PreviewEvent } from "./terminalSessionPreviewMessages";
import { collectMessages, isSessionInProgress } from "./terminalSessionPreviewMessages";

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

describe("isSessionInProgress", () => {
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

  test("末尾が tool なら進行中", () => {
    expect(isSessionInProgress([user, tool])).toBe(true);
  });

  test("末尾が thinking なら進行中", () => {
    expect(isSessionInProgress([user, assistant, thinking])).toBe(true);
  });

  test("末尾が assistant (発言) ならリセットされる", () => {
    expect(isSessionInProgress([user, tool, assistant])).toBe(false);
  });

  test("末尾が user (発言) ならリセットされる", () => {
    expect(isSessionInProgress([assistant, tool, user])).toBe(false);
  });

  test("空配列は進行中でない", () => {
    expect(isSessionInProgress([])).toBe(false);
  });
});
