import { describe, expect, test } from "bun:test";
import { lostPromptDetail } from "./lostPrompt";

describe("lostPromptDetail", () => {
  test("指示文があれば本文をそのまま添える", () => {
    // 手で渡し直せることが目的なので、要約せず本文を出す
    const detail = lostPromptDetail("parser の失敗を直して");
    expect(detail).toBe(" The instruction was not delivered: parser の失敗を直して");
  });

  test("指示文が無い経路では何も足さない", () => {
    // picker 経由の作成は prefill だけで prompt を持たない。文面に空の但し書きを出さない
    expect(lostPromptDetail(undefined)).toBe("");
    expect(lostPromptDetail("")).toBe("");
  });

  test("先頭に区切りを持ち、前の文へ連結できる", () => {
    expect(`Failed to spawn terminal.${lostPromptDetail("x")}`).toBe(
      "Failed to spawn terminal. The instruction was not delivered: x",
    );
  });
});
