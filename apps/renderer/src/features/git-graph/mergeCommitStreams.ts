import type { GitCommit } from "@gozd/rpc";

/**
 * ソートモード。
 * - date: commit date 降順で tie-break（並行する系統が日付で混在する）
 * - topo: 直前のコミットの親を優先し、同一系統をまとめる
 */
export type SortMode = "date" | "topo";

/**
 * HEAD 系統とデフォルトブランチ系統のコミットストリームをマージする。
 *
 * - headCommits の hash set を作り、defaultBranchCommits が到達可能か判定する
 * - 繋がる場合のみ defaultBranchCommits の差分を追加する
 * - union した visible commits を逆トポロジカルソート（Kahn のアルゴリズム）で並べる
 */
export function mergeCommitStreams({
  headCommits,
  defaultBranchCommits,
  sortMode = "date",
}: {
  headCommits: GitCommit[];
  defaultBranchCommits: GitCommit[];
  sortMode?: SortMode;
}): GitCommit[] {
  if (defaultBranchCommits.length === 0) return topoSort(headCommits, sortMode);

  const headHashSet = new Set(headCommits.map((c) => c.hash));

  // defaultBranchCommits 全体を走査し、head 側にないコミットを収集する。
  // date-order ではマージにより共有コミットが途中に混在するため、
  // 最初の共有コミットで打ち切ると必要な祖先を落とす。
  const defaultOnly: GitCommit[] = [];
  let connected = false;
  for (const commit of defaultBranchCommits) {
    if (headHashSet.has(commit.hash)) {
      connected = true;
    } else {
      defaultOnly.push(commit);
    }
  }

  // 繋がらない場合は headCommits のみ
  if (!connected) return topoSort(headCommits, sortMode);

  // union: headCommits + defaultBranchCommits のうち headCommits にないもの
  const unionCommits = [...headCommits, ...defaultOnly];

  return topoSort(unionCommits, sortMode);
}

/**
 * 逆トポロジカルソート（Kahn のアルゴリズム）。
 * child が parent より先に出る順序を保証する。
 *
 * tie-break:
 * - date: commit date 降順（並行する系統が日付で混在する）
 * - topo: 直前のコミットの第1親を優先し、同一系統をまとめる。該当なしなら date fallback
 */
function topoSort(commits: GitCommit[], sortMode: SortMode): GitCommit[] {
  const commitMap = new Map<string, GitCommit>();
  for (const c of commits) {
    commitMap.set(c.hash, c);
  }

  // visible な子の数を計算（visible = commitMap に含まれる）
  const childCount = new Map<string, number>();
  for (const c of commits) {
    if (!childCount.has(c.hash)) childCount.set(c.hash, 0);
    for (const parentHash of c.parents) {
      if (commitMap.has(parentHash)) {
        childCount.set(parentHash, (childCount.get(parentHash) ?? 0) + 1);
      }
    }
  }

  // in-degree が 0 のノードを ready queue に入れる
  const ready: GitCommit[] = [];
  for (const c of commits) {
    if (childCount.get(c.hash) === 0) {
      ready.push(c);
    }
  }

  const result: GitCommit[] = [];
  let lastOutput: GitCommit | undefined;

  while (ready.length > 0) {
    const commit = pickNext(ready, sortMode, lastOutput);
    result.push(commit);
    lastOutput = commit;

    // この commit の親の child count を減らす
    for (const parentHash of commit.parents) {
      const count = childCount.get(parentHash);
      if (count === undefined) continue;
      const newCount = count - 1;
      childCount.set(parentHash, newCount);
      if (newCount === 0) {
        const parent = commitMap.get(parentHash);
        if (parent) ready.push(parent);
      }
    }
  }

  return result;
}

/**
 * ready queue から次に出力するコミットを選択して取り出す。
 * - date: date 降順
 * - topo: 直前のコミットの第1親を優先、なければ date 降順 fallback
 */
function pickNext(
  ready: GitCommit[],
  sortMode: SortMode,
  lastOutput: GitCommit | undefined,
): GitCommit {
  if (sortMode === "topo" && lastOutput) {
    const [firstParent] = lastOutput.parents;
    if (firstParent) {
      const idx = ready.findIndex((c) => c.hash === firstParent);
      if (idx !== -1) {
        return ready.splice(idx, 1)[0];
      }
    }
  }

  // date fallback
  ready.sort((a, b) => b.date - a.date);
  return ready.shift()!;
}
