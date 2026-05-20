import type { GitCommit } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { buildRangeHashes } from "./rangeHashes";

/**
 * `buildRangeHashes` は uncommitted sentinel を引数経由で受ける純粋関数なので、
 * テストでは production 値 (worktree/constants の `UNCOMMITTED_HASH = "0000..."`) と
 * 一致させる必要はない。任意の sentinel 文字列でも `selected/compare === sentinel`
 * の同一性で UNCOMMITTED 経路の挙動が決まる。
 *
 * production 値をリテラルで複製すると SSOT 二重管理になるため、テスト内では非生産値の
 * 合成 sentinel を使う。これにより worktree barrel import を経由せずに済み、
 * `rpc/messages.ts` の `window.__gozdReceive` 副作用 (bun test 環境では fail) も
 * 踏まないで済む。
 */
const WT_SENTINEL = "__test-working-tree__";

/**
 * テスト用 commit。first-parent walk のみ意味があるので parents[0] のみ設定する。
 * graph 形:
 *   commits[0] = "c0" (HEAD, parents: [c1])
 *   commits[1] = "c1" (parents: [c2])
 *   commits[2] = "c2" (parents: [c3])
 *   commits[3] = "c3" (root, no parents)
 */
function makeCommits(): GitCommit[] {
  return [
    {
      hash: "c0",
      shortHash: "c0",
      parents: ["c1"],
      author: "",
      date: 0,
      message: "",
      body: "",
      refs: ["HEAD"],
    },
    {
      hash: "c1",
      shortHash: "c1",
      parents: ["c2"],
      author: "",
      date: 0,
      message: "",
      body: "",
      refs: [],
    },
    {
      hash: "c2",
      shortHash: "c2",
      parents: ["c3"],
      author: "",
      date: 0,
      message: "",
      body: "",
      refs: [],
    },
    {
      hash: "c3",
      shortHash: "c3",
      parents: [],
      author: "",
      date: 0,
      message: "",
      body: "",
      refs: [],
    },
  ];
}

function makeMap(commits: GitCommit[]): Map<string, number> {
  return new Map(commits.map((c, i) => [c.hash, i]));
}

describe("buildRangeHashes", () => {
  test("両端実 hash の通常ケース: newer から older まで first-parent walk", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // c0 → c1 → c2 まで 3 件を含む閉区間
    expect(buildRangeHashes("c0", "c2", map, commits, WT_SENTINEL)).toEqual(["c0", "c1", "c2"]);
  });

  test("両端の順序を逆にしても結果は変わらない (newer 自動判定)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes("c2", "c0", map, commits, WT_SENTINEL)).toEqual(["c0", "c1", "c2"]);
  });

  test("同じ hash を両端に渡したら 1 件のみ", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes("c1", "c1", map, commits, WT_SENTINEL)).toEqual(["c1"]);
  });

  test("newer = WT_SENTINEL: HEAD ref を持つ commit から walk 開始", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes(WT_SENTINEL, "c1", map, commits, WT_SENTINEL)).toEqual(["c0", "c1"]);
  });

  test("片端 WT_SENTINEL は常に newer 扱い: HEAD から実 hash まで walk", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // Working Tree は時系列上「最も新しい」ので UNCOMMITTED 側が newer に倒れる。
    // selected="c1" / compare=UNCOMMITTED → newer=HEAD(c0), older=c1。walk は c0→c1 で停止。
    expect(buildRangeHashes("c1", WT_SENTINEL, map, commits, WT_SENTINEL)).toEqual(["c0", "c1"]);
  });

  test("両端 WT_SENTINEL: HEAD から walk して root まで進む", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes(WT_SENTINEL, WT_SENTINEL, map, commits, WT_SENTINEL)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
    ]);
  });

  test("HEAD ref を持つ commit が無いまま newer=WT_SENTINEL を渡すと空配列", () => {
    const commits: GitCommit[] = [
      {
        hash: "c0",
        shortHash: "c0",
        parents: [],
        author: "",
        date: 0,
        message: "",
        body: "",
        refs: [], // HEAD ref を持たない
      },
    ];
    const map = makeMap(commits);
    expect(buildRangeHashes(WT_SENTINEL, WT_SENTINEL, map, commits, WT_SENTINEL)).toEqual([]);
  });

  test("commits 空配列: 空を返す", () => {
    expect(buildRangeHashes("c0", "c1", new Map(), [], WT_SENTINEL)).toEqual([]);
  });

  test("hashToIndex に無い hash を渡した場合 (片側 = stale / 未取得)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // 未知 hash 側は Infinity 扱いになり、もう片端 (c1) が newer に倒れる。
    // older 側 = Infinity → stopIdx = Infinity で walk は最後 (root) まで進む。
    // 「stale な hash を渡しても crash せず、可能な範囲で walk が走る」契約。
    expect(buildRangeHashes("unknown", "c1", map, commits, WT_SENTINEL)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  test("newer 側に未知 hash が立つと walk 開始時点で即 break (空配列)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // selected="c0", compare="unknown" のとき sIdx=0, cIdx=Infinity → newer=selected(c0)
    // が選ばれて正常 walk。逆に compare="c0", selected="unknown" だと cIdx=0, sIdx=Infinity
    // → newer=compare(c0)、ここまでは同じ。「両端 unknown」だと sIdx=cIdx=Infinity で
    // newerRaw=selected (unknown)、startHash=unknown → while で idx=undefined → 即 break。
    expect(buildRangeHashes("unknown", "other-unknown", map, commits, WT_SENTINEL)).toEqual([]);
  });

  test("root commit に到達したら parents 空で停止 (older が辿れないケース)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // older = root の親 (存在しない). older が hashToIndex に無いので Infinity 扱い、
    // walk は root に到達して parents[0] が undefined → break
    expect(buildRangeHashes("c0", "unknown-root-parent", map, commits, WT_SENTINEL)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
    ]);
  });
});
