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

  test("HEAD がグラフ内に子を持つ (= tip でない) 場合は固定しない", () => {
    // c0 が c1 (HEAD) を parent に持つ。HEAD は祖先側なので最左固定すると線が壊れる。
    // 通常の貪欲割り当てに倒し、c0 と同じ lane を共有する。
    const commits = [commit("c0", ["c1"]), commit("c1", ["c2"], ["HEAD"]), commit("c2", [])];
    const lanes = laneByHash(computeGraphLayout(commits, { headHash: "c1" }));
    expect(lanes.get("c1")).toBe(lanes.get("c0"));
  });

  test("headHash 未指定なら従来どおり先頭コミットが最左", () => {
    const commits = [commit("c0", ["c1"]), commit("c1", [])];
    const lanes = laneByHash(computeGraphLayout(commits, {}));
    expect(lanes.get("c0")).toBe(0);
  });
});
