import { describe, expect, test } from "bun:test";
import type { PreviewEvent } from "./terminalSessionPreviewMessages";
import { collectMessages } from "./terminalSessionPreviewMessages";

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
  test("代表例: 各 run は最終発言で代表し、最新 assistant run だけ末尾 3 件展開する", () => {
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

  test("最後が user run でも、途中にある最新 assistant run が展開される", () => {
    const input = events("u1", "a", "a1-1", "a1-2", "u2");
    expect(texts(input)).toEqual(["u1", "a", "a1-1", "a1-2", "u2"]);
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
