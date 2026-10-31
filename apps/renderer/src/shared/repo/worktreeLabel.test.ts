import { describe, expect, test } from "bun:test";
import { worktreeLabel } from "./worktreeLabel";

describe("worktreeLabel", () => {
  test("branch を持つ worktree は branch 名を出す", () => {
    expect(worktreeLabel({ branch: "feature/x", path: "/w/feature-x" })).toBe("feature/x");
  });

  test("detached の worktree どうしはディレクトリ名で区別される", () => {
    expect(worktreeLabel({ branch: "", path: "/w/check-a" })).toBe("check-a");
    expect(worktreeLabel({ branch: "", path: "/w/check-b" })).toBe("check-b");
  });

  test("bare の entry はディレクトリ名を出す", () => {
    expect(worktreeLabel({ branch: "", path: "/w/repo.git" })).toBe("repo.git");
  });
});
