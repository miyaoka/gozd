import type { GitCommit } from "@gozd/rpc";

/**
 * 隣接する2行間のラインセグメント。
 * vscode-git-graph の Branch.Line に対応。
 */
export interface LineSegment {
  /** 開始点の x（レーン番号） */
  x1: number;
  /** 開始点の y（行番号） */
  y1: number;
  /** 終了点の x（レーン番号） */
  x2: number;
  /** 終了点の y（行番号） */
  y2: number;
  /** 色インデックス */
  color: number;
  /**
   * true: カーブは上端に固定（x1 < x2: 右へ分岐）
   * false: カーブは下端に固定（x1 > x2: 左へ合流）
   */
  lockedFirst: boolean;
}

/** グラフ上の1行分のデータ */
export interface GraphNode {
  commit: GitCommit;
  /** この行のレーン（x 座標） */
  lane: number;
  /** 色インデックス */
  color: number;
}

/** レーン計算の結果 */
export interface GraphLayout {
  nodes: GraphNode[];
  /** 全ラインセグメント */
  lines: LineSegment[];
  /** グラフ全体のレーン数（描画幅の計算に使用） */
  maxLanes: number;
}

/**
 * コミット一覧からグラフレイアウトを計算する。
 *
 * vscode-git-graph と同じ行単位セグメントモデル:
 * - activeLanes[i] = そのレーンで追跡中のコミットハッシュと色
 * - 各行で全アクティブレーンの通過線を明示的にセグメントとして生成
 * - レーン移動は lockedFirst = (x1 < x2) で分岐/合流の向きを制御
 *
 * 各行の処理:
 * - 前の行のレーン状態 → この行のレーン状態への遷移をセグメントとして出力
 * - マージ合流: 複数レーンが1つに集約（前行のレーンからこの行のメインレーンへ）
 * - 分岐: マージコミットのレーンから新レーンへ分岐（この行のレーンから次行の新レーンへ）
 */
/**
 * 各レーンの状態。
 * hash: 次に来ると期待されるコミット
 * color: このレーンの色
 * originLane: このレーンが分岐した元のレーン（最初のセグメントで斜め線を引くため）
 *             undefined なら分岐ではなく通常の通過
 */
interface LaneState {
  hash: string;
  color: number;
  originLane?: number;
}

/**
 * @param reservedLanes 左端に確保する空きレーン数。全ノード・ラインの lane が右にシフトされる
 */
export function computeGraphLayout(commits: GitCommit[], { reservedLanes = 0 } = {}): GraphLayout {
  const commitIndexMap = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    commitIndexMap.set(commits[i].hash, i);
  }

  const activeLanes: (LaneState | undefined)[] = [];
  let nextColor = 0;
  let maxLanes = 0;

  const nodes: GraphNode[] = [];
  const lines: LineSegment[] = [];

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];

    // --- Phase 1: この行に到達するセグメントを生成 ---
    // 前の行のレーン状態からこの行への遷移

    // このコミットが期待されている全レーンを収集
    const matchingLanes: number[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i]?.hash === commit.hash) matchingLanes.push(i);
    }

    let lane: number;
    let color: number;

    if (matchingLanes.length > 0) {
      lane = matchingLanes[0];
      color = activeLanes[lane]!.color;
    } else {
      lane = findEmptyLane(activeLanes);
      color = nextColor++;
    }

    // 前の行(row-1)から到達するセグメントを生成
    if (row > 0) {
      for (let i = 0; i < activeLanes.length; i++) {
        const state = activeLanes[i];
        if (state === undefined) continue;

        if (state.originLane !== undefined) {
          // 分岐: 元のレーンからこのレーンへの斜め線
          lines.push({
            x1: state.originLane,
            y1: row - 1,
            x2: i,
            y2: row,
            color: state.color,
            lockedFirst: true,
          });
          // originLane をクリア（最初の1セグメントだけ斜め）
          state.originLane = undefined;
        } else if (matchingLanes.length > 1 && matchingLanes.includes(i) && i !== lane) {
          // 合流: このレーンからメインレーンへの斜め線
          lines.push({
            x1: i,
            y1: row - 1,
            x2: lane,
            y2: row,
            color: state.color,
            lockedFirst: false,
          });
        } else {
          // 通過: 同じレーンで垂直線
          lines.push({
            x1: i,
            y1: row - 1,
            x2: i,
            y2: row,
            color: state.color,
            lockedFirst: true,
          });
        }
      }
    }

    // --- Phase 2: 合流レーンを解放 ---
    if (matchingLanes.length > 1) {
      for (let k = 1; k < matchingLanes.length; k++) {
        activeLanes[matchingLanes[k]] = undefined;
      }
    }

    // --- Phase 3: このコミットのレーン状態を更新 ---
    const [firstParent, ...restParents] = commit.parents;

    if (firstParent !== undefined) {
      activeLanes[lane] = { hash: firstParent, color };
    } else {
      activeLanes[lane] = undefined;
    }

    // マージ元の親（2番目以降）を新レーンに配置
    for (const parentHash of restParents) {
      if (!commitIndexMap.has(parentHash)) continue;

      const existingLane = activeLanes.findIndex((l) => l?.hash === parentHash);
      if (existingLane === -1) {
        const mergeLane = findEmptyLane(activeLanes);
        const mergeColor = nextColor++;
        // originLane を設定して、次の行で斜めセグメントを生成
        activeLanes[mergeLane] = { hash: parentHash, color: mergeColor, originLane: lane };
      }
    }

    maxLanes = Math.max(maxLanes, countActive(activeLanes));
    nodes.push({ commit, lane: lane + reservedLanes, color });
  }

  if (reservedLanes > 0) {
    for (const seg of lines) {
      seg.x1 += reservedLanes;
      seg.x2 += reservedLanes;
    }
  }

  return { nodes, lines, maxLanes: Math.max(maxLanes, 1) + reservedLanes };
}

function findEmptyLane(lanes: (LaneState | undefined)[]): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === undefined) return i;
  }
  return lanes.length;
}

function countActive(lanes: (LaneState | undefined)[]): number {
  let count = 0;
  for (const lane of lanes) {
    if (lane !== undefined) count++;
  }
  return count;
}
