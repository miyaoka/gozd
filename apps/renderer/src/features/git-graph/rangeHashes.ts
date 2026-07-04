import type { GitCommit } from "@gozd/rpc";

/**
 * 範囲選択時の対象 commit hash 列を組み立てる。
 *
 * 仕様: newer (上端) から `commit.parents[0]` を辿り、older の表示位置に到達したら停止する。
 * 「先端ブランチの first-parent walk」を表現し、別枝の独立コミット
 * (date 順で混在する origin/HEAD 系の commit など) は対象に含まれない。
 *
 * 終了条件:
 *   - 次の commit が older の表示位置を超えた (older 自身は first-parent 線上にあれば含む)
 *   - 次の commit が commits 配列に存在しない (= log フェッチ範囲外)
 *   - parents[0] が無い (= root commit)
 *
 * uncommittedHash 端の扱い:
 *   - newer = uncommittedHash: HEAD ref を持つ commit を walk 開始点にフォールバック
 *   - older = uncommittedHash: stopIdx = -1 → 即停止すべきところを Infinity に倒し、
 *     walk が最後まで進むようにする (Working Tree 端は「最も新しい」扱い)
 *
 * `uncommittedHash` は worktree feature の `UNCOMMITTED_HASH` を呼び出し側が渡す。
 * 引数経由にすることで rangeHashes 自体は worktree barrel に依存しなくなり、
 * 純粋関数として独立にテスト可能になる。
 */
export function buildRangeHashes(
  selected: string,
  compare: string,
  hashToIndex: Map<string, number>,
  commits: readonly GitCommit[],
  uncommittedHash: string,
): string[] {
  const sIdx = selected === uncommittedHash ? -1 : (hashToIndex.get(selected) ?? Infinity);
  const cIdx = compare === uncommittedHash ? -1 : (hashToIndex.get(compare) ?? Infinity);

  const newerIsSelected = sIdx <= cIdx;
  const newerRaw = newerIsSelected ? selected : compare;
  const olderIdxRaw = newerIsSelected ? cIdx : sIdx;

  const startHash =
    newerRaw === uncommittedHash
      ? (commits.find((c) => c.refs.includes("HEAD"))?.hash ?? "")
      : newerRaw;
  if (startHash === "") return [];

  // older が UNCOMMITTED_HASH (-1) の場合は stopIdx を Infinity にして最後まで walk する
  const stopIdx = olderIdxRaw < 0 ? Number.POSITIVE_INFINITY : olderIdxRaw;

  const result: string[] = [];
  let currentHash = startHash;
  while (true) {
    const idx = hashToIndex.get(currentHash);
    if (idx === undefined || idx > stopIdx) break;
    const commit = commits[idx];
    result.push(commit.hash);
    if (idx === stopIdx) break; // older 自身に到達。追加してから停止
    const firstParent = commit.parents[0];
    if (firstParent === undefined) break;
    currentHash = firstParent;
  }
  return result;
}
