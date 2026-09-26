import { describe, expect, test } from "bun:test";
import type { PoolSessionRow } from "../../../session";
import type { ClaudeStatus } from "../../../terminal";
import { groupByStatus } from "./statusGroups";

function row(
  sessionId: string,
  opts: {
    status?: ClaudeStatus;
    stateSince?: number;
    lastActivity?: number;
    live?: boolean;
    rootDir?: string;
  },
): PoolSessionRow {
  const rootDir = opts.rootDir ?? "/repo";
  return {
    sessionId,
    dir: rootDir,
    title: sessionId,
    live: opts.live ?? opts.status !== undefined,
    status: opts.status,
    stateSince: opts.stateSince,
    lastActivity: opts.lastActivity,
    rootDir,
    repoName: rootDir.slice(1),
    owner: "",
    branch: "main",
  };
}

const ids = (rows: readonly PoolSessionRow[]) => rows.map((r) => r.sessionId);

describe("groupByStatus", () => {
  test("端末が開いている行は 要対応 → 完了 → 実行中 → 待機 の順。pendingWork 付きの done は実行中、未起動は待機", () => {
    const groups = groupByStatus(
      [
        row("idle", { status: { state: "idle", lastActivityAt: 1 }, stateSince: 5 }),
        row("fresh", { live: true }),
        row("working", { status: { state: "working", lastActivityAt: 1 }, stateSince: 4 }),
        row("pending", {
          status: { state: "done", lastActivityAt: 1, pendingWork: true },
          stateSince: 3,
        }),
        row("done", { status: { state: "done", lastActivityAt: 1 }, stateSince: 2 }),
        row("asking", { status: { state: "asking", lastActivityAt: 1 }, stateSince: 1 }),
        row("stopped", { lastActivity: 1 }),
      ],
      ["/repo"],
    );
    expect(groups.active.map((g) => g.rootDir)).toEqual(["/repo"]);
    expect(ids(groups.active[0]?.rows ?? [])).toEqual([
      "asking",
      "done",
      "working",
      "pending",
      "idle",
      "fresh",
    ]);
    expect(ids(groups.inactive)).toEqual(["stopped"]);
  });

  test("同じ状態の中は状態に入った時刻の新しい順で、最終活動では並べない", () => {
    const groups = groupByStatus(
      [
        row("older", {
          status: { state: "done", lastActivityAt: 900 },
          stateSince: 100,
          lastActivity: 900,
        }),
        row("newer", {
          status: { state: "done", lastActivityAt: 50 },
          stateSince: 200,
          lastActivity: 50,
        }),
      ],
      ["/repo"],
    );
    expect(ids(groups.active[0]?.rows ?? [])).toEqual(["newer", "older"]);
  });

  test("repo は現れた順に並び、中の状態では動かない。順に無い repo は末尾", () => {
    const groups = groupByStatus(
      [
        row("c-asking", {
          rootDir: "/c",
          status: { state: "asking", lastActivityAt: 1 },
          stateSince: 9,
        }),
        row("b-asking", {
          rootDir: "/b",
          status: { state: "asking", lastActivityAt: 1 },
          stateSince: 8,
        }),
        row("a-idle", {
          rootDir: "/a",
          status: { state: "idle", lastActivityAt: 1 },
          stateSince: 1,
        }),
        row("a-done", {
          rootDir: "/a",
          status: { state: "done", lastActivityAt: 1 },
          stateSince: 2,
        }),
      ],
      ["/a", "/b"],
    );
    expect(groups.active.map((g) => [g.rootDir, ids(g.rows)])).toEqual([
      ["/a", ["a-done", "a-idle"]],
      ["/b", ["b-asking"]],
      ["/c", ["c-asking"]],
    ]);
  });

  test("端末の開いていない行は repo でまとめず、最終活動の新しい順", () => {
    const groups = groupByStatus(
      [
        row("old", { lastActivity: 100, rootDir: "/a" }),
        row("new", { lastActivity: 200, rootDir: "/b" }),
        row("mid", { lastActivity: 150, rootDir: "/a" }),
      ],
      [],
    );
    expect(ids(groups.inactive)).toEqual(["new", "mid", "old"]);
  });
});
