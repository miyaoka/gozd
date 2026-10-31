import { describe, expect, test } from "bun:test";
import { branchLabel, isDetached } from "./branchLabel";

describe("branchLabel", () => {
  test("branch を持つ worktree は branch 名をそのまま出す", () => {
    expect(branchLabel({ branch: "feature/x", path: "/w/feature-x" })).toBe("feature/x");
  });

  test("detached の worktree どうしはディレクトリ名で区別される", () => {
    expect(branchLabel({ branch: "", path: "/w/check-a" })).toBe("check-a");
    expect(branchLabel({ branch: "", path: "/w/check-b/" })).toBe("check-b");
  });
});

describe("isDetached", () => {
  test("空文字の branch を detached とみなす", () => {
    expect(isDetached("")).toBe(true);
    expect(isDetached("main")).toBe(false);
  });
});
