import type { GitCommit } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { DisplayRef } from "./displayRef";
import {
  computeDisplayRefs,
  computeOutOfSyncBranches,
  graphBranchNames,
  hasOriginRef,
  prLookupBranch,
} from "./graphRefs";

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

/** DisplayRef の snapshot。検証したいフィールドだけ上書きする */
function displayRef(over: Partial<DisplayRef> = {}): DisplayRef {
  return {
    label: "feat/a",
    type: "local",
    isSynced: false,
    isOutOfSync: false,
    isCurrent: false,
    isDefault: false,
    ...over,
  };
}

describe("prLookupBranch", () => {
  test("local と synced はラベルがそのまま branch 名", () => {
    expect(prLookupBranch(displayRef({ type: "local" }))).toBe("feat/a");
    expect(prLookupBranch(displayRef({ type: "synced" }))).toBe("feat/a");
  });

  test("remote は origin/ を剥がして local と同じ名前に寄せる", () => {
    expect(prLookupBranch(displayRef({ type: "remote", label: "origin/feat/a" }))).toBe("feat/a");
  });

  test("tag は branch ではないので引かない", () => {
    expect(prLookupBranch(displayRef({ type: "tag", label: "v1.0.0" }))).toBeUndefined();
  });
});

describe("hasOriginRef", () => {
  test("synced と remote は origin が載っている", () => {
    expect(hasOriginRef(displayRef({ type: "synced" }))).toBe(true);
    expect(hasOriginRef(displayRef({ type: "remote", label: "origin/feat/a" }))).toBe(true);
  });

  // local は未 push と「origin が別 commit」の 2 系統を含む。どちらも origin は載っていない
  test("local には origin が載っていない", () => {
    expect(hasOriginRef(displayRef({ type: "local" }))).toBe(false);
  });

  test("tag には origin が無い", () => {
    expect(hasOriginRef(displayRef({ type: "tag", label: "v1.0.0" }))).toBe(false);
  });
});

describe("graphBranchNames", () => {
  test("local と remote を同じ branch 名に寄せる", () => {
    const names = graphBranchNames([
      commit("a1", ["feat/a"]),
      commit("b2", ["origin/feat/a", "origin/b"]),
    ]);
    expect(names.sort()).toEqual(["b", "feat/a"]);
  });

  test("HEAD / origin/HEAD / tag は branch ではない", () => {
    expect(graphBranchNames([commit("a1", ["HEAD", "origin/HEAD", "tag:v1.0.0"])])).toEqual([]);
  });

  test("ref を持たない commit だけなら空", () => {
    expect(graphBranchNames([commit("a1", [])])).toEqual([]);
  });
});
