import { describe, expect, test } from "bun:test";
import type { Selection } from "../worktree";
import { resolveOpenablePath } from "./resolveOpenablePath";

describe("resolveOpenablePath", () => {
  const rel: Selection = { kind: "worktreeRelative", relPath: "src/a.ts" };
  const abs: Selection = { kind: "absolute", absPath: "/tmp/outside/b.ts" };

  test("worktreeRelative は dir と join した絶対パスを返す", () => {
    expect(
      resolveOpenablePath({
        selection: rel,
        dir: "/work/repo",
        isNotFound: false,
        effectiveGitChange: undefined,
      }),
    ).toBe("/work/repo/src/a.ts");
  });

  test("absolute は absPath を直に返す", () => {
    expect(
      resolveOpenablePath({
        selection: abs,
        dir: "/work/repo",
        isNotFound: false,
        effectiveGitChange: undefined,
      }),
    ).toBe("/tmp/outside/b.ts");
  });

  test("selection 無し → undefined", () => {
    expect(
      resolveOpenablePath({
        selection: undefined,
        dir: "/work/repo",
        isNotFound: false,
        effectiveGitChange: undefined,
      }),
    ).toBeUndefined();
  });

  test("isNotFound (working tree に実体無し) → undefined で silent dead button を防ぐ", () => {
    expect(
      resolveOpenablePath({
        selection: rel,
        dir: "/work/repo",
        isNotFound: true,
        effectiveGitChange: undefined,
      }),
    ).toBeUndefined();
  });

  test("絶対パス選択でも isNotFound なら undefined", () => {
    expect(
      resolveOpenablePath({
        selection: abs,
        dir: "/work/repo",
        isNotFound: true,
        effectiveGitChange: undefined,
      }),
    ).toBeUndefined();
  });

  test("deleted (commit / PR diff モードで削除済み版を表示中) → undefined", () => {
    expect(
      resolveOpenablePath({
        selection: rel,
        dir: "/work/repo",
        isNotFound: false,
        effectiveGitChange: "deleted",
      }),
    ).toBeUndefined();
  });

  test("worktreeRelative なのに dir 未確立 → undefined", () => {
    expect(
      resolveOpenablePath({
        selection: rel,
        dir: undefined,
        isNotFound: false,
        effectiveGitChange: undefined,
      }),
    ).toBeUndefined();
  });
});
