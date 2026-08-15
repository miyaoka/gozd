import type { Task } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { compareTaskOrder } from "./utils";

function task(id: string, createdAt: string): Task {
  return {
    id,
    worktreeDir: "",
    userTitle: id,
    terminalTitle: "",
    ghTitle: "",
    sessionId: "",
    createdAt,
    closedByUser: false,
    ghRef: undefined,
  };
}

describe("compareTaskOrder", () => {
  test("createdAt の昇順に並べる", () => {
    const later = task("later", "2026-08-15T00:00:02.000Z");
    const earlier = task("earlier", "2026-08-15T00:00:01.000Z");

    expect([later, earlier].sort(compareTaskOrder).map((t) => t.id)).toEqual(["earlier", "later"]);
  });

  test("createdAt が同時刻なら入力順を保つ", () => {
    const first = task("first", "2026-08-15T00:00:00.000Z");
    const second = task("second", "2026-08-15T00:00:00.000Z");

    expect([first, second].sort(compareTaskOrder).map((t) => t.id)).toEqual(["first", "second"]);
    expect([second, first].sort(compareTaskOrder).map((t) => t.id)).toEqual(["second", "first"]);
  });
});
