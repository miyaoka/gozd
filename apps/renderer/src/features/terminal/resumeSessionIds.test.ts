import { describe, expect, test } from "bun:test";
import { buildResumeSessionIds } from "./resumeSessionIds";

describe("buildResumeSessionIds", () => {
  test("preferred なし → saved リストをそのまま返す (app-close 自動復元)", () => {
    expect(buildResumeSessionIds(undefined, ["a", "b"])).toEqual(["a", "b"]);
  });

  test("preferred なし + saved 空 → 空配列 (autostart 経路へ倒れる)", () => {
    expect(buildResumeSessionIds(undefined, [])).toEqual([]);
  });

  test("preferred が saved に無い → 先頭に追加 (closed session の初回 click)", () => {
    expect(buildResumeSessionIds("x", ["a", "b"])).toEqual(["x", "a", "b"]);
  });

  test("preferred が saved に含まれる → 重複除外して先頭へ", () => {
    expect(buildResumeSessionIds("b", ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  test("preferred あり + saved 空 → preferred 単要素", () => {
    expect(buildResumeSessionIds("x", [])).toEqual(["x"]);
  });
});
