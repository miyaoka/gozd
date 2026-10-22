import { describe, expect, test } from "bun:test";
import {
  INITIAL_TEXT_INPUT_STATE,
  reduceTextInput,
  toPreeditRuns,
  type TextInputEvent,
  type TextInputState,
} from "./textInputState";

function run(events: TextInputEvent[]) {
  let state: TextInputState = INITIAL_TEXT_INPUT_STATE;
  const sent: string[] = [];
  let clears = 0;
  for (const event of events) {
    const next = reduceTextInput(state, event);
    state = next.state;
    for (const effect of next.effects) {
      if (effect.kind === "send") sent.push(effect.data);
      else clears++;
    }
  }
  return { state, sent, clears };
}

describe("reduceTextInput", () => {
  test("変換中の textupdate は送らず、確定でだけ 1 回送る", () => {
    const { state, sent, clears } = run([
      { type: "compositionstart" },
      { type: "textupdate", bufferText: "きょう" },
      { type: "textupdate", bufferText: "今日" },
      { type: "compositionend", bufferText: "今日" },
    ]);
    expect(sent).toEqual(["今日"]);
    expect(clears).toBe(1);
    expect(state).toEqual(INITIAL_TEXT_INPUT_STATE);
  });

  test("変換外の textupdate はその場で送り、バッファを空に戻す", () => {
    const { sent, clears } = run([
      { type: "textupdate", bufferText: "A" },
      { type: "textupdate", bufferText: "@" },
    ]);
    expect(sent).toEqual(["A", "@"]);
    expect(clears).toBe(2);
  });

  test("空で確定したら送らずにバッファだけ空に戻す", () => {
    const { sent, clears } = run([
      { type: "compositionstart" },
      { type: "textupdate", bufferText: "a" },
      { type: "textupdate", bufferText: "" },
      { type: "compositionend", bufferText: "" },
    ]);
    expect(sent).toEqual([]);
    expect(clears).toBe(1);
  });

  test("変換中は preedit と formats を持ち、変換外の formats は捨てる", () => {
    const formats = [
      { rangeStart: 0, rangeEnd: 3, underlineStyle: "solid", underlineThickness: "thick" },
    ] as const;
    expect(run([{ type: "textformatupdate", formats }]).state.formats).toEqual([]);
    const { state } = run([
      { type: "compositionstart" },
      { type: "textupdate", bufferText: "今日は" },
      { type: "textformatupdate", formats },
    ]);
    expect(state).toEqual({ composing: true, preedit: "今日は", formats });
  });
});

describe("toPreeditRuns", () => {
  test("実測した文節の範囲を太線と細線の区間に分ける", () => {
    // gozd の実アプリで日本語 IME が渡した値
    const runs = toPreeditRuns("今日はいい天気", [
      { rangeStart: 0, rangeEnd: 3, underlineStyle: "solid", underlineThickness: "thick" },
      { rangeStart: 3, rangeEnd: 7, underlineStyle: "solid", underlineThickness: "thin" },
    ]);
    expect(runs).toEqual([
      { start: 0, text: "今日は", underline: { thickness: "thick", style: "solid" } },
      { start: 3, text: "いい天気", underline: { thickness: "thin", style: "solid" } },
    ]);
  });

  test("範囲の外は下線なし、preedit の外を指す範囲は切り詰める", () => {
    const runs = toPreeditRuns("abcde", [
      { rangeStart: 1, rangeEnd: 2, underlineStyle: "dotted", underlineThickness: "thin" },
      { rangeStart: 4, rangeEnd: 9, underlineStyle: "solid", underlineThickness: "thick" },
    ]);
    expect(runs.map((r) => [r.text, r.underline?.thickness])).toEqual([
      ["a", undefined],
      ["b", "thin"],
      ["cd", undefined],
      ["e", "thick"],
    ]);
    expect(runs.map((r) => r.text).join("")).toBe("abcde");
  });

  test("none の範囲と formats が空のときは下線なしの 1 区間", () => {
    expect(
      toPreeditRuns("ab", [
        { rangeStart: 0, rangeEnd: 2, underlineStyle: "solid", underlineThickness: "none" },
      ]),
    ).toEqual([{ start: 0, text: "ab", underline: undefined }]);
    expect(toPreeditRuns("", [])).toEqual([]);
  });
});
