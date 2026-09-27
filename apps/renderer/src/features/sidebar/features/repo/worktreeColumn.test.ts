import { describe, expect, test } from "bun:test";
import type { DirSessionRows, SessionRow } from "../../../session";
import { buildWorktreeColumn, type WorktreeColumnItem } from "./worktreeColumn";

const liveRow: SessionRow = {
  sessionId: "s",
  dir: "/repo",
  title: "s",
  live: true,
  status: undefined,
  stateSince: undefined,
  lastActivity: undefined,
};

function entry(path: string, card: boolean): { path: string; sessionRows: DirSessionRows } {
  return { path, sessionRows: { live: card ? [liveRow] : [], inactive: [] } };
}

/** worktree は path、区切りは "|" で表す */
function layout(items: WorktreeColumnItem<{ path: string }>[]): string[] {
  return items.map((item) => (item.kind === "worktree" ? item.entry.path : "|"));
}

describe("buildWorktreeColumn", () => {
  test("カードとその隣の境目にだけ区切りを置く", () => {
    const items = buildWorktreeColumn([
      entry("a", false),
      entry("b", false),
      entry("c", true),
      entry("d", true),
      entry("e", false),
    ]);
    expect(layout(items)).toEqual(["a", "b", "|", "c", "|", "d", "|", "e"]);
  });

  test("列の端がカードでも端には区切りを置かない", () => {
    const items = buildWorktreeColumn([entry("a", true), entry("b", false), entry("c", true)]);
    expect(layout(items)).toEqual(["a", "|", "b", "|", "c"]);
  });

  test("ヘッダ 1 行の worktree だけなら区切りを置かない", () => {
    expect(layout(buildWorktreeColumn([entry("a", false), entry("b", false)]))).toEqual(["a", "b"]);
  });

  test("空の列は空", () => {
    expect(buildWorktreeColumn([])).toEqual([]);
  });
});
