import type { GitCommit } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { computeDisplayRefs, computeOutOfSyncBranches } from "./graphRefs";

/** テスト用 commit を最小フィールドで生成する */
function commit(hash: string, refs: string[]): GitCommit {
  return {
    hash,
    shortHash: hash,
    parents: [],
    author: "",
    date: 0,
    message: "",
    body: "",
    refs,
    truncatedAbove: false,
  };
}

describe("computeDisplayRefs", () => {
  test("HEAD / origin/HEAD は除外する", () => {
    const result = computeDisplayRefs(["HEAD", "origin/HEAD", "main"]);
    expect(result.map((r) => r.label)).toEqual(["main"]);
  });

  test("ローカルと origin/同名が同一 commit にあれば synced に統合する", () => {
    const result = computeDisplayRefs(["feat", "origin/feat"]);
    expect(result).toEqual([
      {
        label: "feat",
        type: "synced",
        isSynced: true,
        isOutOfSync: false,
        isCurrent: false,
        isDefault: false,
      },
    ]);
  });

  test("origin のみ (ローカル対応なし) は remote タイプで残す", () => {
    const result = computeDisplayRefs(["origin/feat"]);
    expect(result).toEqual([
      {
        label: "origin/feat",
        type: "remote",
        isSynced: false,
        isOutOfSync: false,
        isCurrent: false,
        isDefault: false,
      },
    ]);
  });

  test("current / default ブランチにフラグを立てる", () => {
    const result = computeDisplayRefs(["feat", "main"], "feat", "main");
    const feat = result.find((r) => r.label === "feat");
    const main = result.find((r) => r.label === "main");
    expect(feat?.isCurrent).toBe(true);
    expect(feat?.isDefault).toBe(false);
    expect(main?.isDefault).toBe(true);
    expect(main?.isCurrent).toBe(false);
  });

  test("out-of-sync set に含まれる非 synced ローカルに isOutOfSync を立てる", () => {
    const result = computeDisplayRefs(["feat"], undefined, undefined, new Set(["feat"]));
    expect(result[0].isOutOfSync).toBe(true);
  });

  test("synced ブランチは out-of-sync set にあっても isOutOfSync にしない", () => {
    const result = computeDisplayRefs(
      ["feat", "origin/feat"],
      undefined,
      undefined,
      new Set(["feat"]),
    );
    expect(result[0]).toMatchObject({ type: "synced", isOutOfSync: false });
  });

  test("tag: プレフィックスは prefix を落として tag タイプにする", () => {
    const result = computeDisplayRefs(["tag:v1.0.0"]);
    expect(result).toEqual([
      {
        label: "v1.0.0",
        type: "tag",
        isSynced: false,
        isOutOfSync: false,
        isCurrent: false,
        isDefault: false,
      },
    ]);
  });
});

describe("computeOutOfSyncBranches", () => {
  test("ローカルと origin/同名が別 commit にあれば out-of-sync として検出する", () => {
    const commits = [commit("a", ["feat"]), commit("b", ["origin/feat"])];
    expect(computeOutOfSyncBranches(commits)).toEqual(new Set(["feat"]));
  });

  test("ローカルと origin/同名が同一 commit なら検出しない", () => {
    const commits = [commit("a", ["feat", "origin/feat"])];
    expect(computeOutOfSyncBranches(commits)).toEqual(new Set());
  });

  test("HEAD / origin/HEAD / tag: は無視する", () => {
    const commits = [
      commit("a", ["HEAD", "feat"]),
      commit("b", ["origin/HEAD", "tag:v1", "origin/feat"]),
    ];
    expect(computeOutOfSyncBranches(commits)).toEqual(new Set(["feat"]));
  });

  test("origin 側のみ (ローカル不在) は out-of-sync にしない", () => {
    const commits = [commit("a", ["origin/feat"])];
    expect(computeOutOfSyncBranches(commits)).toEqual(new Set());
  });
});
