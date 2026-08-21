import type { GitPullRequestBadge } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { PrBadgeEntry } from "./usePrBadgeStore";
import { mergeBadgeEntries, PR_BADGE_FRESH_MS, staleBranches } from "./usePrBadgeStore";

const NOW = 1_000_000;

function entries(input: Record<string, number>): Map<string, PrBadgeEntry> {
  return new Map(Object.entries(input).map(([branch, fetchedAt]) => [branch, { fetchedAt }]));
}

describe("staleBranches", () => {
  test("未取得の branch は対象", () => {
    expect(staleBranches({ entries: undefined, branches: ["a", "b"], now: NOW })).toEqual([
      "a",
      "b",
    ]);
  });

  test("取得済みで新しい branch は対象外", () => {
    const result = staleBranches({
      entries: entries({ a: NOW - 1 }),
      branches: ["a"],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  // 境界: 期限ちょうどは抜けたとみなす
  test("lock 期限ちょうどは対象", () => {
    const result = staleBranches({
      entries: entries({ a: NOW - PR_BADGE_FRESH_MS }),
      branches: ["a"],
      now: NOW,
    });
    expect(result).toEqual(["a"]);
  });

  // 切替で増えた branch だけを引く。集合が変わるたび全件引き直すと lock が意味を失う
  test("新しく現れた branch だけを返す", () => {
    const result = staleBranches({
      entries: entries({ a: NOW - 1, b: NOW - 1 }),
      branches: ["a", "b", "c"],
      now: NOW,
    });
    expect(result).toEqual(["c"]);
  });

  // 描かなくなった branch は問いから外れるだけで、引き直しの対象にはしない
  test("要求していない branch は返さない", () => {
    const result = staleBranches({
      entries: entries({ a: 0 }),
      branches: ["b"],
      now: NOW,
    });
    expect(result).toEqual(["b"]);
  });

  test("要求順を保つ", () => {
    const result = staleBranches({ entries: undefined, branches: ["c", "a", "b"], now: NOW });
    expect(result).toEqual(["c", "a", "b"]);
  });
});

/** バッジ 1 件の snapshot。検証に要るのは headRef と number だけ */
function badge(headRef: string, number: number): GitPullRequestBadge {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    headRef,
    baseRefOid: "abc",
    commentCount: 0,
  };
}

describe("mergeBadgeEntries", () => {
  test("応答に含まれる branch は PR を載せ、時刻を進める", () => {
    const result = mergeBadgeEntries({
      entries: undefined,
      branches: ["a"],
      prs: [badge("a", 1)],
      now: NOW,
    });
    expect(result.get("a")).toEqual({ pr: badge("a", 1), fetchedAt: NOW });
  });

  // 「引いたが PR が無かった」は成功した取得の結果であって、失敗ではない
  test("応答に含まれない要求 branch は pr を落として時刻を進める", () => {
    const result = mergeBadgeEntries({
      entries: new Map([["a", { pr: badge("a", 1), fetchedAt: 0 }]]),
      branches: ["a"],
      prs: [],
      now: NOW,
    });
    expect(result.get("a")).toEqual({ pr: undefined, fetchedAt: NOW });
  });

  // 失敗でキャッシュを壊すと、取れていた PR が「PR を持たない branch」と同じ見た目になる
  test("失敗では前回の PR を保ち、時刻だけ進める", () => {
    const result = mergeBadgeEntries({
      entries: new Map([["a", { pr: badge("a", 1), fetchedAt: 0 }]]),
      branches: ["a"],
      prs: undefined,
      now: NOW,
    });
    expect(result.get("a")).toEqual({ pr: badge("a", 1), fetchedAt: NOW });
  });

  // 差し替えにすると、別の問いを立てた取得が既存のキャッシュを消す
  test("要求に含まれない branch のキャッシュは触らない", () => {
    const result = mergeBadgeEntries({
      entries: new Map([["keep", { pr: badge("keep", 9), fetchedAt: 0 }]]),
      branches: ["a"],
      prs: [badge("a", 1)],
      now: NOW,
    });
    expect(result.get("keep")).toEqual({ pr: badge("keep", 9), fetchedAt: 0 });
  });

  test("入力の Map を書き換えない", () => {
    const before = new Map([["a", { pr: badge("a", 1), fetchedAt: 0 }]]);
    mergeBadgeEntries({ entries: before, branches: ["a"], prs: [], now: NOW });
    expect(before.get("a")).toEqual({ pr: badge("a", 1), fetchedAt: 0 });
  });
});
