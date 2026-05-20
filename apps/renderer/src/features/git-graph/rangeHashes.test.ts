import type { GitCommit } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { buildRangeHashes } from "./rangeHashes";

/**
 * テスト内では UNCOMMITTED_HASH の実値 (40 zeros) をリテラルで使う。
 * worktree barrel を import すると rpc/messages.ts の `window.__gozdReceive` 副作用が
 * 走り bun test (window 無し) で fail する。rangeHashes.ts は引数経由で sentinel を
 * 受ける契約のため、テストも引数で渡してテスト境界の独立性を保つ。
 */
const UNCOMMITTED_HASH = "0000000000000000000000000000000000000000";

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
    expect(buildRangeHashes("c0", "c2", map, commits, UNCOMMITTED_HASH)).toEqual([
      "c0",
      "c1",
      "c2",
    ]);
  });

  test("両端の順序を逆にしても結果は変わらない (newer 自動判定)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes("c2", "c0", map, commits, UNCOMMITTED_HASH)).toEqual([
      "c0",
      "c1",
      "c2",
    ]);
  });

  test("同じ hash を両端に渡したら 1 件のみ", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes("c1", "c1", map, commits, UNCOMMITTED_HASH)).toEqual(["c1"]);
  });

  test("newer = UNCOMMITTED_HASH: HEAD ref を持つ commit から walk 開始", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(buildRangeHashes(UNCOMMITTED_HASH, "c1", map, commits, UNCOMMITTED_HASH)).toEqual([
      "c0",
      "c1",
    ]);
  });

  test("片端 UNCOMMITTED_HASH は常に newer 扱い: HEAD から実 hash まで walk", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // Working Tree は時系列上「最も新しい」ので UNCOMMITTED 側が newer に倒れる。
    // selected="c1" / compare=UNCOMMITTED → newer=HEAD(c0), older=c1。walk は c0→c1 で停止。
    expect(buildRangeHashes("c1", UNCOMMITTED_HASH, map, commits, UNCOMMITTED_HASH)).toEqual([
      "c0",
      "c1",
    ]);
  });

  test("両端 UNCOMMITTED_HASH: HEAD から walk して root まで進む", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    expect(
      buildRangeHashes(UNCOMMITTED_HASH, UNCOMMITTED_HASH, map, commits, UNCOMMITTED_HASH),
    ).toEqual(["c0", "c1", "c2", "c3"]);
  });

  test("HEAD ref を持つ commit が無いまま newer=UNCOMMITTED_HASH を渡すと空配列", () => {
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
    expect(
      buildRangeHashes(UNCOMMITTED_HASH, UNCOMMITTED_HASH, map, commits, UNCOMMITTED_HASH),
    ).toEqual([]);
  });

  test("commits 空配列: 空を返す", () => {
    expect(buildRangeHashes("c0", "c1", new Map(), [], UNCOMMITTED_HASH)).toEqual([]);
  });

  test("hashToIndex に無い hash を渡した場合 (片側 = stale / 未取得)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // 未知 hash 側は Infinity 扱いになり、もう片端 (c1) が newer に倒れる。
    // older 側 = Infinity → stopIdx = Infinity で walk は最後 (root) まで進む。
    // 「stale な hash を渡しても crash せず、可能な範囲で walk が走る」契約。
    expect(buildRangeHashes("unknown", "c1", map, commits, UNCOMMITTED_HASH)).toEqual([
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
    expect(buildRangeHashes("unknown", "other-unknown", map, commits, UNCOMMITTED_HASH)).toEqual(
      [],
    );
  });

  test("root commit に到達したら parents 空で停止 (older が辿れないケース)", () => {
    const commits = makeCommits();
    const map = makeMap(commits);
    // older = root の親 (存在しない). older が hashToIndex に無いので Infinity 扱い、
    // walk は root に到達して parents[0] が undefined → break
    expect(buildRangeHashes("c0", "unknown-root-parent", map, commits, UNCOMMITTED_HASH)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
    ]);
  });
});
