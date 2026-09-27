import { describe, expect, test } from "bun:test";
import type { DirSessionRows, SessionRow } from "../../../session";
import { groupWorktreeEntries } from "./worktreeGroups";

const liveRow: SessionRow = {
  sessionId: "s",
  dir: "/repo",
  title: "s",
  live: true,
  status: undefined,
  stateSince: undefined,
  lastActivity: undefined,
};

function entry(name: string, card: boolean): { name: string; sessionRows: DirSessionRows } {
  return { name, sessionRows: { live: card ? [liveRow] : [], inactive: [] } };
}

function names(groups: { name: string }[][]): string[][] {
  return groups.map((group) => group.map((e) => e.name));
}

describe("groupWorktreeEntries", () => {
  test("続くヘッダ 1 行の worktree を 1 グループにまとめ、カードは 1 件で 1 グループにする", () => {
    const groups = groupWorktreeEntries([
      entry("a", false),
      entry("b", false),
      entry("c", true),
      entry("d", true),
      entry("e", false),
    ]);
    expect(names(groups)).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
  });

  test("全件がヘッダ 1 行なら 1 グループ", () => {
    expect(names(groupWorktreeEntries([entry("a", false), entry("b", false)]))).toEqual([
      ["a", "b"],
    ]);
  });

  test("空の列はグループを作らない", () => {
    expect(groupWorktreeEntries([])).toEqual([]);
  });
});
