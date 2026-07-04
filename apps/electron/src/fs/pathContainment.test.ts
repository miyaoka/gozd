// resolveContained の pure unit test。Swift 版 `PathContainmentTests.swift` の
// ケースを対で移植し、両シェルの containment 契約が一致していることを固定する。

import { describe, expect, test } from "bun:test";
import { resolveContained } from "./pathContainment";

describe("resolveContained (path containment SSOT)", () => {
  // FS 非依存を保証するため、存在しない base を使う（削除済み worktree root 相当）
  const base = "/Users/x/.local/share/gozd/worktrees/deleted-wt/branch";

  test('空 / "." は base 自身に解決する', () => {
    expect(resolveContained(base, "")).toBe(base);
    expect(resolveContained(base, ".")).toBe(base);
  });

  test("通常の相対 path は base 配下に join する", () => {
    expect(resolveContained(base, "sub/a.txt")).toBe(`${base}/sub/a.txt`);
  });

  test('内部の ".." は base を抜けなければ正規化して許可する', () => {
    expect(resolveContained(base, "a/../b")).toBe(`${base}/b`);
  });

  test('base を抜ける ".." traversal は undefined', () => {
    expect(resolveContained(base, "../escape")).toBeUndefined();
    expect(resolveContained(base, "a/../../b")).toBeUndefined();
  });

  test("絶対パス注入は root を除去して base 配下へ閉じ込める", () => {
    expect(resolveContained(base, "/etc/passwd")).toBe(`${base}/etc/passwd`);
  });
});
