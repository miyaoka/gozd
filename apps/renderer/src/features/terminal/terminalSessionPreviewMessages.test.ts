import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../session-log";
import {
  collectRuns,
  countInProgressActions,
  endsWithInterrupt,
  type PreviewSpeech,
  previewSpeeches,
  type RunRow,
  runKey,
  runRows,
} from "./terminalSessionPreviewMessages";

const TS = "2026-06-12T00:00:00Z";

// "u1" → user, "a3" → assistant のように先頭文字で話者を決め、ラベルを text に入れる
function event(label: string): TranscriptEvent {
  return { kind: label.startsWith("u") ? "user" : "assistant", text: label, ts: TS };
}

// rewind の分岐点。selectedChildUuid が表示している枝の先頭レコード
function branchEvent(selectedChildUuid: string): TranscriptEvent {
  return { kind: "branch", ts: TS, branchKey: "p", selectedChildUuid, options: [] };
}

// 分岐点の無いログの発言列
function speeches(...labels: string[]): PreviewSpeech[] {
  return previewSpeeches(labels.map(event));
}

// 行を読みやすい文字列にする。トグルは "[+N]"、発言は本文
function labels(rows: RunRow[]): string[] {
  return rows.map((row) => (row.kind === "toggle" ? `[+${row.foldableCount}]` : row.speech.text));
}

// 全 run を畳んだ状態で表示される発言。interrupted はログが中断で終わったか
function texts(input: PreviewSpeech[], interrupted = false): string[] {
  return collectRuns(input, interrupted).flatMap((run) =>
    runRows(run, false, "below").flatMap((row) => (row.kind === "speech" ? [row.speech.text] : [])),
  );
}

describe("collectRuns (全 run を畳んだ表示)", () => {
  test("代表例: 各 run は最終発言で代表し、応答中の assistant run だけ末尾 3 件出す", () => {
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

  test("run の数に上限は無く、最古の run も残る", () => {
    const input = speeches("u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4");
    expect(texts(input)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
  });

  test("assistant 発言のみのログでも最新 run の末尾 3 件が出る", () => {
    const input = speeches("a1", "a2", "a3", "a4");
    expect(texts(input)).toEqual(["a2", "a3", "a4"]);
  });

  // 中断で応答は終わっている。末尾の assistant run を応答中として展開しない
  test("ログが中断で終わっていれば、末尾の assistant run も 1 件代表に畳む", () => {
    const input = speeches("u1", "a1-1", "a1-2", "a1-3");
    expect(texts(input, true)).toEqual(["u1", "a1-3"]);
  });

  // 空文字の発言は発言にならないため、挟まっても同じ話者の連続は 1 run に束ねられる。
  // 空 user で分断されると assistant run が 2 つに割れ a1-1 が代表化されてしまう
  test("空文字の発言を挟んだ同じ話者の連続は 1 run に束ねられる", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", text: "u1", ts: TS },
      { kind: "assistant", text: "a1-1", ts: TS },
      { kind: "user", text: "", ts: TS },
      { kind: "assistant", text: "a1-2", ts: TS },
      { kind: "assistant", text: "a1-3", ts: TS },
      { kind: "assistant", text: "a1-4", ts: TS },
    ];
    expect(texts(previewSpeeches(events))).toEqual(["u1", "a1-2", "a1-3", "a1-4"]);
  });

  test("分岐点の前後で同じ話者の発言が続いても、run を分ける", () => {
    const events = [event("u1"), event("a1"), branchEvent("x"), event("a2"), event("a3")];
    const runs = collectRuns(previewSpeeches(events), false);
    expect(runs.map((r) => r.speeches.map((s) => s.text))).toEqual([["u1"], ["a1"], ["a2", "a3"]]);
  });

  // start は開閉状態の識別に使うため、末尾への追記で既存 run の値が変わってはならない
  test("run の start は発言列全体での先頭位置で、追記しても既存 run の値は変わらない", () => {
    const before = collectRuns(speeches("u1", "a", "a1", "u2"), false);
    const after = collectRuns(speeches("u1", "a", "a1", "u2", "u", "a2"), false);
    expect(before.map((r) => r.start)).toEqual([0, 1, 3]);
    expect(after.map((r) => r.start)).toEqual([0, 1, 3, 5]);
  });
});

describe("previewSpeeches", () => {
  test("発言には直前の分岐点で表示している枝が付き、分岐点より前は空文字", () => {
    const events = [event("u1"), branchEvent("x"), event("a1"), branchEvent("y"), event("u2")];
    expect(previewSpeeches(events).map(({ speech, branch }) => [speech.text, branch])).toEqual([
      ["u1", ""],
      ["a1", "x"],
      ["u2", "y"],
    ]);
  });
});

describe("runKey", () => {
  function keysOf(events: TranscriptEvent[]): string[] {
    return collectRuns(previewSpeeches(events), false).map((run) => runKey("s", run));
  }

  // 表示するセッションログが切り替わっても、同じ start の別の run と状態を共有しない
  test("同じ start の run でも、セッションログが違えば key が違う", () => {
    const [run] = collectRuns(speeches("u1"), false);
    if (run === undefined) throw new Error("no run");
    expect(runKey("agent-a", run)).not.toBe(runKey("agent-b", run));
  });

  test("同じ枝への追記で run が伸びても key は変わらない", () => {
    const before = keysOf([event("u1"), event("a1")]);
    const after = keysOf([event("u1"), event("a1"), event("a2")]);
    expect(after).toEqual(before);
  });

  // rewind すると分岐点より後ろが新しい枝に置き換わり、同じ start に新しい run が来る。
  // 開閉状態を引き継がないよう key が変わり、分岐点より前の run の key は変わらない
  test("rewind で置き換わった run は key が変わり、分岐点より前の run の key は変わらない", () => {
    const before = keysOf([event("u1"), event("a1"), event("u2"), event("a2")]);
    const afterRewind = keysOf([
      event("u1"),
      event("a1"),
      branchEvent("new-u2"),
      event("u2'"),
      event("a2'"),
    ]);
    expect(afterRewind.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(afterRewind[2]).not.toBe(before[2]);
    expect(afterRewind[3]).not.toBe(before[3]);
  });

  test("同じ分岐点で 2 回目の rewind をすると、置き換わった run の key がまた変わる", () => {
    const first = keysOf([event("u1"), branchEvent("b1"), event("u2"), event("a2")]);
    const second = keysOf([event("u1"), branchEvent("b2"), event("u2''"), event("a2''")]);
    expect(second[0]).toBe(first[0]);
    expect(second.slice(1)).not.toEqual(first.slice(1));
  });
});

describe("runRows", () => {
  function runOf(...input: string[]) {
    const run = collectRuns(speeches(...input), false).at(-1);
    if (run === undefined) throw new Error("no run");
    return run;
  }

  test("畳んだ run は古い側を隠し、末尾の直前に隠れる件数つきのトグルを置く", () => {
    const run = runOf("u1", "u2", "u3");
    expect(labels(runRows(run, false, "below"))).toEqual(["[+2]", "u3"]);
    expect(labels(runRows(run, false, "above"))).toEqual(["[+2]", "u3"]);
  });

  test("開いた run は、隠れていた発言をトグルの revealSide 側に出す", () => {
    const run = runOf("u1", "u2", "u3");
    expect(labels(runRows(run, true, "below"))).toEqual(["[+2]", "u1", "u2", "u3"]);
    expect(labels(runRows(run, true, "above"))).toEqual(["u1", "u2", "[+2]", "u3"]);
  });

  test("畳んで隠れる発言が無い run にはトグルを置かない", () => {
    expect(labels(runRows(runOf("u1", "a1", "a2"), false, "below"))).toEqual(["a1", "a2"]);
    expect(labels(runRows(runOf("a1"), true, "above"))).toEqual(["a1"]);
  });

  // index は発言の v-for key に使う。開閉で同じ発言の index が変わると DOM が作り替えられる
  test("発言の index は発言列全体での位置で、開閉によらず同じ発言は同じ index を持つ", () => {
    const run = runOf("u1", "a1", "a2", "a3", "a4", "a5");
    const indexes = (rows: RunRow[]) =>
      rows.flatMap((row) => (row.kind === "speech" ? [row.index] : []));
    expect(indexes(runRows(run, false, "below"))).toEqual([3, 4, 5]);
    expect(indexes(runRows(run, true, "below"))).toEqual([1, 2, 3, 4, 5]);
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

  const interrupt: TranscriptEvent = { kind: "interrupt", ts: "2026-06-12T00:00:00Z" };

  // 中断は吹き出しに出ないが、それより前の tool はユーザーが止めた作業で進行中ではない。
  test("末尾が中断ならリセットされる", () => {
    expect(countInProgressActions([user, tool, tool, interrupt])).toBe(0);
  });

  test("中断より後の tool だけを数える", () => {
    expect(countInProgressActions([user, tool, interrupt, tool])).toBe(1);
  });
});

describe("endsWithInterrupt", () => {
  const interrupt: TranscriptEvent = { kind: "interrupt", ts: TS };
  const tool: TranscriptEvent = {
    kind: "tool",
    name: "Bash",
    input: {},
    toolUseId: "t1",
    ts: TS,
    result: undefined,
  };
  const system: TranscriptEvent = { kind: "system", label: "hook", text: "x", ts: TS };

  test("直近のターン境界が中断なら true", () => {
    expect(endsWithInterrupt([event("u1"), event("a1"), interrupt])).toBe(true);
  });

  // 境界にならない event は読み飛ばして直近の境界を見る
  test("中断の後ろに境界でない event が続いても true", () => {
    expect(endsWithInterrupt([event("a1"), interrupt, tool, system])).toBe(true);
  });

  test("中断の後ろに発言があれば false", () => {
    expect(endsWithInterrupt([event("a1"), interrupt, event("u2")])).toBe(false);
  });

  test("中断が無ければ false", () => {
    expect(endsWithInterrupt([event("u1"), event("a1"), tool])).toBe(false);
    expect(endsWithInterrupt([])).toBe(false);
  });
});
