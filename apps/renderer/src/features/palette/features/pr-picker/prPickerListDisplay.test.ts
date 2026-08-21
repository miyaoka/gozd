import { describe, expect, test } from "bun:test";
import type { PrPickerListInput } from "./prPickerListDisplay";
import { prPickerCountsLabel, prPickerEmptyMessage } from "./prPickerListDisplay";

function input(over: Partial<PrPickerListInput> = {}): PrPickerListInput {
  return {
    isFiltered: false,
    shownCount: 100,
    loadedCount: 100,
    totalCount: 152,
    hasMore: true,
    ...over,
  };
}

describe("prPickerCountsLabel", () => {
  test("絞り込みが無ければ取得済みと総数だけを出す", () => {
    expect(prPickerCountsLabel(input())).toBe("100 loaded / 152 total");
  });

  test("絞り込み中は結果件数を先頭に足す", () => {
    expect(prPickerCountsLabel(input({ isFiltered: true, shownCount: 12 }))).toBe(
      "12 shown / 100 loaded / 152 total",
    );
  });

  // 分母が無い状態で loaded だけ出すと、全件なのか途中なのかを読み分けられない
  test("総数が取れていなければ何も出さない", () => {
    expect(prPickerCountsLabel(input({ totalCount: 0 }))).toBe("");
    expect(prPickerCountsLabel(input({ totalCount: 0, isFiltered: true, shownCount: 3 }))).toBe("");
  });

  // total は fork を除外する前の数なので、取り切っても loaded が届かないことがある
  test("取り切っていても loaded が total に届かないことを表記で潰さない", () => {
    expect(prPickerCountsLabel(input({ loadedCount: 148, hasMore: false }))).toBe(
      "148 loaded / 152 total",
    );
  });
});

describe("prPickerEmptyMessage", () => {
  test.each([
    [{ isFiltered: false, hasMore: false }, "No open pull requests"],
    [{ isFiltered: false, hasMore: true }, "No pull requests in the loaded pages"],
    [{ isFiltered: true, hasMore: false }, "No matching pull requests"],
    [{ isFiltered: true, hasMore: true }, "No match in the loaded pull requests"],
  ])("%o は %s", (state, expected) => {
    expect(prPickerEmptyMessage(state)).toBe(expected);
  });

  // 4 通りがすべて別の文言。同じ文言に畳むと「まだ取っていない」と「存在しない」が混ざる
  test("4 通りの状態がすべて別の文言になる", () => {
    const messages = [false, true].flatMap((isFiltered) =>
      [false, true].map((hasMore) => prPickerEmptyMessage({ isFiltered, hasMore })),
    );
    expect(new Set(messages).size).toBe(4);
  });
});
