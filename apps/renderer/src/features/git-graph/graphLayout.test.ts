import type { GitCommit } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { computeGraphLayout } from "./graphLayout";

/** テスト用 commit を最小フィールドで生成する */
function commit(hash: string, parents: string[], refs: string[] = []): GitCommit {
  return { hash, shortHash: hash, parents, author: "", date: 0, message: "", body: "", refs };
}

/** hash → lane の引きやすいマップに変換する */
function laneByHash(layout: ReturnType<typeof computeGraphLayout>): Map<string, number> {
  return new Map(layout.nodes.map((n) => [n.commit.hash, n.lane]));
}

describe("computeGraphLayout の HEAD 最左固定", () => {
  test("HEAD が表示順の先頭なら最左 lane (0) に置く", () => {
    const commits = [commit("c0", ["c1"], ["HEAD"]), commit("c1", ["c2"]), commit("c2", [])];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "c0" }));
    expect(lanes.get("c0")).toBe(0);
  });

  test("分岐により他枝が HEAD より上に並んでも HEAD を最左に固定する", () => {
    // o0/o1: origin 側の分岐コミット (HEAD より新しく表示順で上)
    // h0: HEAD (tip)。base が共通祖先
    //   o0 → o1 ┐
    //           ├→ base
    //   h0 ─────┘
    const commits = [
      commit("o0", ["o1"]),
      commit("o1", ["base"]),
      commit("h0", ["base"], ["HEAD"]),
      commit("base", []),
    ];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "h0" }));
    // HEAD は予約された最左 lane (0) に固定される
    expect(lanes.get("h0")).toBe(0);
    // 上に並ぶ origin 枝は右側へ追いやられる
    expect(lanes.get("o0")).toBeGreaterThan(0);
    expect(lanes.get("o1")).toBeGreaterThan(0);
    // 共通祖先は HEAD 系統に合流して最左に戻る
    expect(lanes.get("base")).toBe(0);
  });

  test("HEAD がグラフ内に子を持つ (= 非 tip) 場合も最左に固定し子を合流させる", () => {
    // c0 が c1 (HEAD) を parent に持つ。HEAD の子 c0 は lane 0 を予約のため lane 1 以降に置かれ、
    // c1 (HEAD) 行で lane 0 へ合流する。detached HEAD で子孫が表示されるケースに相当。
    const commits = [commit("c0", ["c1"]), commit("c1", ["c2"], ["HEAD"]), commit("c2", [])];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "c1" }));
    expect(lanes.get("c1")).toBe(0);
    expect(lanes.get("c0")).toBeGreaterThan(0);
  });

  test("HEAD 到達前の merge コミットの 2nd parent が予約 lane 0 を奪わない", () => {
    // 上枝が内部 merge を持ち、HEAD (h0) は tip。merge (m) は headRow より前の行。
    // m の 2nd parent (u2) が lane 0 を取ると h0 が最左を確保できないため、
    // findEmptyLane の minLane=1 により u2 は lane 1 以降へ追いやられる必要がある。
    //   u0 → m ┬─ u1 ┐
    //          └─ u2 ┤
    //   h0 ─────────┤
    //            base┘
    const commits = [
      commit("u0", ["m"]),
      commit("m", ["u1", "u2"]),
      commit("u1", ["base"]),
      commit("h0", ["base"], ["HEAD"]),
      commit("u2", ["base"]),
      commit("base", []),
    ];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "h0" }));
    expect(lanes.get("h0")).toBe(0);
    // merge の 2nd parent は予約 lane 0 を避けて右へ配置される
    expect(lanes.get("u2")).toBeGreaterThan(0);
    expect(lanes.get("base")).toBe(0);
  });

  test("HEAD 自身が merge コミットの tip でも最左 lane に固定する", () => {
    //   o0 → o1 ┐
    //   m(HEAD)─┼─ a ┐
    //           └─ b ┤
    //            base┘
    const commits = [
      commit("o0", ["o1"]),
      commit("o1", ["base"]),
      commit("m", ["a", "b"], ["HEAD"]),
      commit("a", ["base"]),
      commit("b", ["base"]),
      commit("base", []),
    ];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "m" }));
    expect(lanes.get("m")).toBe(0);
    expect(lanes.get("o0")).toBeGreaterThan(0);
  });

  test("非 tip な HEAD に複数の子がある場合も lane 0 に固定し全子を合流させる", () => {
    // a/b が h (HEAD) を parent に持つ (h は 2 つの子を持つ非 tip)。
    //   a ┐ b ┐
    //     ├───┤
    //   h(HEAD)┘ → c
    const commits = [
      commit("a", ["h"]),
      commit("b", ["h"]),
      commit("h", ["c"], ["HEAD"]),
      commit("c", []),
    ];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "h" }));
    expect(lanes.get("h")).toBe(0);
    expect(lanes.get("a")).toBeGreaterThan(0);
    expect(lanes.get("b")).toBeGreaterThan(0);
    expect(lanes.get("c")).toBe(0);
  });

  test("headHash が表示集合に存在しない (maxCount 打ち切り等) 場合は従来レイアウト", () => {
    const commits = [commit("c0", ["c1"]), commit("c1", [])];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "missing" }));
    expect(lanes.get("c0")).toBe(0);
  });

  test("headHash 未指定なら従来どおり先頭コミットが最左", () => {
    const commits = [commit("c0", ["c1"]), commit("c1", [])];
    const lanes = laneByHash(computeGraphLayout(commits, {}));
    expect(lanes.get("c0")).toBe(0);
  });
});
