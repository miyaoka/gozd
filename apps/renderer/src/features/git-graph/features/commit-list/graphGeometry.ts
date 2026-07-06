/**
 * commit graph のレーン / 行の座標変換 (純関数)。行と SVG が同じ座標系を共有するよう、定数と変換を
 * 1 箇所に集約する。
 */

/** グラフ描画の定数 */
export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 24;
export const DOT_RADIUS = 4;
/** HEAD ドットの外側リング半径をドット本体からどれだけ離すか (px)。塗り/選択とは別チャンネルで
 *  「今 HEAD がいる場所」を輪で示す。 */
export const HEAD_RING_GAP = 3;
export const GRAPH_PADDING_X = 12;

/**
 * col 1 (graph 列) の右側に確保する HEAD marker `→` 用余白 (px)。
 * marker は col 1 内に in-flow 右寄せ配置されるため、SVG が描く lane / dot と marker の
 * x 帯が物理的に重ならない width をここで予約する。
 * 内訳: marker glyph ~14 + col 2 との padding 4 + 安全余白 2 = 20。
 */
const HEAD_MARKER_RIGHT_PADDING = 20;

/** Graph 列の幅。右側は HEAD marker 分の余白を確保する。 */
export function graphColumnWidth(maxLanes: number): number {
  return GRAPH_PADDING_X + maxLanes * LANE_WIDTH + HEAD_MARKER_RIGHT_PADDING;
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
