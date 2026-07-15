/**
 * commit graph のレーン / 行の座標変換 (純関数)。行と SVG が同じ座標系を共有するよう、定数と変換を
 * 1 箇所に集約する。
 */

/** グラフ描画の定数 */
export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 24;
export const DOT_RADIUS = 4;
export const GRAPH_PADDING_X = 12;
/** HEAD マーカー: 行左端に置く右向き三角形。apex が右にどれだけ伸びるか / base の縦幅 (px)。 */
const HEAD_MARKER_WIDTH = 8;
const HEAD_MARKER_HEIGHT = 12;

/**
 * col 1 (graph 列) の右側に確保するガター (px)。最右レーンの dot が col 2 の description に
 * 密着しないための余白。HEAD は行左端の右向き三角マーカーで示す (グラフ座標系に置く)。
 */
const GRAPH_RIGHT_GUTTER = 8;

/** Graph 列の幅。右側に最右レーンの dot 用のガターを確保する。 */
export function graphColumnWidth(maxLanes: number): number {
  return GRAPH_PADDING_X + maxLanes * LANE_WIDTH + GRAPH_RIGHT_GUTTER;
}

/** レーン番号 → X ピクセル座標 */
export function laneX(lane: number): number {
  return GRAPH_PADDING_X + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** 行番号 → Y ピクセル座標（行の中央） */
export function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * HEAD マーカーの polygon points。行左端 (x=0) に縦の base を立て、apex を右に尖らせた右向き三角形。
 * 左ボーダーの縦バーを右へ尖らせた形で、HEAD 行と進行方向 (コミット側) を指す。
 */
export function headMarkerPoints(row: number): string {
  const cy = rowY(row);
  const halfH = HEAD_MARKER_HEIGHT / 2;
  return `0,${cy - halfH} ${HEAD_MARKER_WIDTH},${cy} 0,${cy + halfH}`;
}

/**
 * ラインセグメントの SVG パスを生成する。引数は lane / row (グラフ座標)、内部で pixel に変換する。
 * 各セグメントは隣接する2行間なので常に1行分の高さ。同じレーンなら垂直線、異なるレーンならベジェ曲線。
 */
export function segmentPath(
  fromLane: number,
  fromRow: number,
  toLane: number,
  toRow: number,
): string {
  const x1 = laneX(fromLane);
  const y1 = rowY(fromRow);
  const x2 = laneX(toLane);
  const y2 = rowY(toRow);

  if (x1 === x2) {
    return `M${x1},${y1}L${x2},${y2}`;
  }

  // ベジェ曲線で滑らかにレーン移動
  const d = ROW_HEIGHT * 0.8;
  return `M${x1},${y1}C${x1},${y1 + d} ${x2},${y2 - d} ${x2},${y2}`;
}
