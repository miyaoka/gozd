import { describe, expect, test } from "bun:test";
import { UNCOMMITTED_HASH } from "../worktree";
import { orderCommitRange } from "./commitRange";

describe("orderCommitRange", () => {
  // commits[0] が newest。idx が小さいほど新しい
  const hashToIndex = new Map([
    ["ccc", 0],
    ["bbb", 1],
    ["aaa", 2],
  ]);

  test("単一選択 (compare=null) は older undefined", () => {
    expect(orderCommitRange("bbb", null, hashToIndex)).toEqual({
      newer: "bbb",
      older: undefined,
    });
  });

  test("範囲選択はクリック順に依存せず時系列で整列する", () => {
    const expected = { newer: "ccc", older: "aaa" };
    expect(orderCommitRange("aaa", "ccc", hashToIndex)).toEqual(expected);
    expect(orderCommitRange("ccc", "aaa", hashToIndex)).toEqual(expected);
  });

  test("UNCOMMITTED_HASH は常に newer 側", () => {
    expect(orderCommitRange(UNCOMMITTED_HASH, "bbb", hashToIndex)).toEqual({
      newer: UNCOMMITTED_HASH,
      older: "bbb",
    });
    expect(orderCommitRange("bbb", UNCOMMITTED_HASH, hashToIndex)).toEqual({
      newer: UNCOMMITTED_HASH,
      older: "bbb",
    });
  });

  test("両端 UNCOMMITTED_HASH は不整合として null", () => {
    expect(orderCommitRange(UNCOMMITTED_HASH, UNCOMMITTED_HASH, hashToIndex)).toBeNull();
  });

  test("map に無い hash (commits 未ロード / stale 選択) は null", () => {
    expect(orderCommitRange("stale", "bbb", hashToIndex)).toBeNull();
    expect(orderCommitRange("bbb", "stale", hashToIndex)).toBeNull();
  });
});
