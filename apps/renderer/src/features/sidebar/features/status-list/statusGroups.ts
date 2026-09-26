import { compareRecentFirst, type PoolSessionRow } from "../../../session";
import { displayClaudeState, type ClaudeState } from "../../../terminal";

/** 端末が開いているセッションの、1 つの repo 分 */
interface ActiveRepoGroup {
  rootDir: string;
  repoName: string;
  owner: string | undefined;
  rows: PoolSessionRow[];
}

export interface StatusGroups {
  /** 端末が開いているもの。repo ごとにまとめ、repo が Active に現れた順（新しいものが先）に並ぶ */
  active: ActiveRepoGroup[];
  /** 端末の開いていないもの。最終活動の新しい順 */
  inactive: PoolSessionRow[];
}

/** 表示上の状態の並び順。注意が要るものほど小さい。未起動は idle と同じ扱い */
const STATE_RANK: Record<ClaudeState, number> = {
  asking: 0,
  done: 1,
  working: 2,
  idle: 3,
};

function rankOf(row: PoolSessionRow): number {
  const state = displayClaudeState(row.status);
  return state === undefined ? STATE_RANK.idle : STATE_RANK[state];
}

/**
 * 状態の順、同じ状態の中は状態に入った時刻の新しい順。並びが変わるきっかけを状態の変化に
 * 限り、常に表示されている一覧で行がずれないようにする。時刻の無い行（状態をまだ持たない）は
 * 最終活動で比べる
 */
function compareActive(a: PoolSessionRow, b: PoolSessionRow): number {
  const byRank = rankOf(a) - rankOf(b);
  if (byRank !== 0) return byRank;
  const bySince = (b.stateSince ?? 0) - (a.stateSince ?? 0);
  return bySince !== 0 ? bySince : compareRecentFirst(a, b);
}

/**
 * 全 repo のセッション行を、端末が開いているものと開いていないものに分けて並べる。
 *
 * 端末が開いているものは repo ごとにまとめ、repo は `repoOrder`（Active に現れた順で、新しいものが
 * 先）に並べる。中のセッションの増減や状態の変化では repo の位置を動かさない。`repoOrder` に
 * まだ無い repo は現れたばかりなので先頭に置く。repo の中の行は状態の順に並ぶ。
 */
export function groupByStatus(
  rows: readonly PoolSessionRow[],
  repoOrder: readonly string[],
): StatusGroups {
  const byRepo = new Map<string, ActiveRepoGroup>();
  for (const row of rows.filter((r) => r.live).toSorted(compareActive)) {
    const group = byRepo.get(row.rootDir);
    if (group !== undefined) {
      group.rows.push(row);
      continue;
    }
    byRepo.set(row.rootDir, {
      rootDir: row.rootDir,
      repoName: row.repoName,
      owner: row.owner,
      rows: [row],
    });
  }
  // 順に無い repo は indexOf が -1 を返し、そのまま先頭に来る。順は同じ行の集合から pre flush の
  // watch で更新されるため、描画時に順に無いのは記録より先に評価された現れたばかりの repo だけ
  const positionOf = (rootDir: string) => repoOrder.indexOf(rootDir);
  return {
    active: [...byRepo.values()].toSorted((a, b) => positionOf(a.rootDir) - positionOf(b.rootDir)),
    inactive: rows.filter((row) => !row.live).toSorted(compareRecentFirst),
  };
}
