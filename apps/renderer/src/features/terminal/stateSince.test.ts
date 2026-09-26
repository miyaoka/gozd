import { describe, expect, test } from "bun:test";
import type { ClaudeStatus } from "./claudeStatus";
import { nextStateSince } from "./stateSince";

describe("nextStateSince", () => {
  test("新しく状態を持った端末は now を記録する", () => {
    const statuses: Record<number, ClaudeStatus> = { 1: { state: "working", lastActivityAt: 5 } };
    expect(nextStateSince({}, statuses, 100)).toEqual({ 1: { state: "working", since: 100 } });
  });

  test("表示上の状態が変わった端末だけ時刻を進め、変わらない端末は元の時刻を保つ", () => {
    const prev = {
      1: { state: "working" as const, since: 10 },
      2: { state: "working" as const, since: 20 },
    };
    const statuses: Record<number, ClaudeStatus> = {
      1: { state: "done", lastActivityAt: 50 },
      2: { state: "working", lastActivityAt: 60 },
    };
    expect(nextStateSince(prev, statuses, 100)).toEqual({
      1: { state: "done", since: 100 },
      2: { state: "working", since: 20 },
    });
  });

  test("pendingWork 付きの done は working と表示されるので、working からは変化と数えない", () => {
    const prev = { 1: { state: "working" as const, since: 10 } };
    const statuses: Record<number, ClaudeStatus> = {
      1: { state: "done", lastActivityAt: 50, pendingWork: true },
    };
    expect(nextStateSince(prev, statuses, 100)).toBe(prev);
  });

  test("同じ状態のまま付随データだけが変わったときは prev をそのまま返す", () => {
    const prev = { 1: { state: "done" as const, since: 10 } };
    const statuses: Record<number, ClaudeStatus> = {
      1: { state: "done", lastActivityAt: 50, message: "updated" },
    };
    expect(nextStateSince(prev, statuses, 100)).toBe(prev);
  });

  test("状態の無くなった端末のエントリは落とす", () => {
    const prev = {
      1: { state: "idle" as const, since: 10 },
      2: { state: "done" as const, since: 20 },
    };
    const statuses: Record<number, ClaudeStatus> = { 2: { state: "done", lastActivityAt: 50 } };
    expect(nextStateSince(prev, statuses, 100)).toEqual({ 2: { state: "done", since: 20 } });
  });
});
