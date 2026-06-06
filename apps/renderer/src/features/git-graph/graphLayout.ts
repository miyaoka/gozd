import type { GitCommit } from "@gozd/proto";

/**
 * 隣接する2行間のラインセグメント。
 * vscode-git-graph の Branch.Line に対応。
 */
interface LineSegment {
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
interface GraphNode {
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

/** HEAD レーン専用に予約する色インデックス。lane 0 = current branch の線を常にこの色で示し、
 *  Working Tree 行のドット/接続線と色を揃える。他レーンは 1 以降を採番して衝突を避ける。 */
export const HEAD_COLOR = 0;

/**
 * @param headHash HEAD コミットの hash。指定すると HEAD を最左 lane (lane 0) に固定し、
 *   色も HEAD_COLOR (0) に固定する。HEAD が表示順で先頭でないときは lane 0 を空きチャンネルとして
 *   予約し、子があれば lane 0 へ合流させる。HEAD が表示集合に存在する間は他レーンの採番を 1 から
 *   始めて HEAD_COLOR の衝突を避ける
 */
export function computeGraphLayout(
  commits: GitCommit[],
  { headHash }: { headHash?: string } = {},
): GraphLayout {
  const commitIndexMap = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    commitIndexMap.set(commits[i].hash, i);
  }

  // HEAD を最左 lane に固定するための予約判定。
  // HEAD が表示順で先頭 (headRow === 0) なら貪欲割り当てで既に最左なので予約不要。
  // それ以外 (HEAD より上に他コミットが並ぶ) のときは、HEAD 到達前の行で lane 0 を
  // 空けて予約し、HEAD 行で lane 0 に固定する。HEAD がグラフ内に子を持つ (= 非 tip) 場合も、
  // 子の各レーンを HEAD 行で lane 0 へ合流させることで lane を壊さず固定できる。
  const headRow = headHash === undefined ? -1 : (commitIndexMap.get(headHash) ?? -1);
  const reserveHeadLane = headRow > 0;

  const activeLanes: (LaneState | undefined)[] = [];
  // HEAD が表示集合内にあるなら色 0 は HEAD 専用に予約し、他レーンは 1 から採番する。
  // HEAD 不在 (headRow < 0) なら予約不要なので従来どおり 0 から採番する。
  let nextColor = headRow >= 0 ? 1 : 0;
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

    const isHead = row === headRow;
    // HEAD 到達前は lane 0 を予約 (空き探索の下限を 1 に上げる) し、HEAD に確保しておく
    const minLane = reserveHeadLane && row < headRow ? 1 : 0;

    if (isHead) {
      // HEAD は常に最左 lane (lane 0) と固定色 (HEAD_COLOR) に置く。
      // 予約中 (headRow > 0) は確保済みの lane 0、HEAD が表示先頭 (headRow === 0) なら
      // 貪欲割り当てでも lane 0 になる。子がある (matchingLanes あり) 場合も lane 0 を優先し、
      // 子の各レーンを下の合流処理で lane 0 へ寄せる。色は子に追従せず HEAD_COLOR に固定して
      // lane 0 = current branch の線を常に同色にし、Working Tree 行と揃える
      lane = reserveHeadLane ? 0 : findEmptyLane(activeLanes, minLane);
      color = HEAD_COLOR;
    } else if (matchingLanes.length > 0) {
      lane = matchingLanes[0];
      color = activeLanes[lane]!.color;
    } else {
      lane = findEmptyLane(activeLanes, minLane);
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
        } else if (matchingLanes.includes(i) && i !== lane) {
          // 合流: このレーンからメインレーンへの斜め線
          // (HEAD 固定では lane=0 が matchingLanes に含まれないため、子レーンすべてが対象)
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
    // この行のレーン (lane) 以外の matching を解放する。通常は matchingLanes[0] === lane なので
    // [1..] を解放。HEAD 固定では lane=0 が matchingLanes に含まれないため全 matching を解放する。
    for (const ml of matchingLanes) {
      if (ml !== lane) activeLanes[ml] = undefined;
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
      if (existingLane !== -1) continue;

      // 2nd parent が HEAD 自身のとき (例: main の "Merge pull request #N from .../HEAD-branch")
      // は予約済み lane 0 / HEAD_COLOR に直接乗せる。findEmptyLane(minLane=1) で借りレーンを
      // 採ると、その borrowed lane の originLane = lane(merge 行) が次行 (HEAD 行) まで持ち越され、
      // Phase 1 で「merge 行 lane → borrowed lane」の分岐セグメントを nextColor++ で 1 本生成
      // してしまう。HEAD は別経路で lane 0 を固定するため borrowed lane は誰にも消費されず
      // 余計な線として残る。HEAD 予約 lane 0 に直行させれば、次行の Phase 1 で
      // activeLanes[0].originLane = merge 行 lane が「分岐」ブロック (lockedFirst=true) を踏み、
      // x1=merge 行 lane → x2=0 の斜めセグメントが HEAD_COLOR で正しく描かれる
      const isHeadBranch = parentHash === headHash && reserveHeadLane;
      const mergeLane = isHeadBranch ? 0 : findEmptyLane(activeLanes, minLane);
      const mergeColor = isHeadBranch ? HEAD_COLOR : nextColor++;
      // originLane を設定して、次の行で斜めセグメントを生成
      activeLanes[mergeLane] = { hash: parentHash, color: mergeColor, originLane: lane };
    }

    maxLanes = Math.max(maxLanes, countActive(activeLanes));
    nodes.push({ commit, lane, color });
  }

  return { nodes, lines, maxLanes: Math.max(maxLanes, 1) };
}

/**
 * @param minLane 探索を開始する最小 lane。HEAD 予約中は 1 を渡して lane 0 を温存する
 */
function findEmptyLane(lanes: (LaneState | undefined)[], minLane = 0): number {
  for (let i = minLane; i < lanes.length; i++) {
    if (lanes[i] === undefined) return i;
  }
  return Math.max(lanes.length, minLane);
}

function countActive(lanes: (LaneState | undefined)[]): number {
  let count = 0;
  for (const lane of lanes) {
    if (lane !== undefined) count++;
  }
  return count;
}
