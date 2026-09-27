import { describe, expect, test } from "bun:test";
import type { DirSessionRows, SessionRow } from "../../../session";
import { visibleSessionRows } from "./visibleSessionRows";

function row(sessionId: string, live: boolean): SessionRow {
  return {
    sessionId,
    dir: "/repo",
    title: sessionId,
    live,
    status: undefined,
    stateSince: undefined,
    lastActivity: undefined,
  };
}

const rows: DirSessionRows = {
  live: [row("live-1", true)],
  inactive: [row("past-1", false), row("past-2", false)],
};

describe("visibleSessionRows", () => {
  test("選択中の dir は端末の開いていないセッションも出す", () => {
    expect(visibleSessionRows(rows, true)).toEqual(rows);
  });

  test("選択中でない dir は端末の開いているセッションだけを出す", () => {
    expect(visibleSessionRows(rows, false)).toEqual({ live: rows.live, inactive: [] });
  });
});
