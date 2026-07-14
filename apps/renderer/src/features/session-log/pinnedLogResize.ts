/**
 * pin ウィンドウの 8 方位リサイズの反対辺アンカー算術 (純関数)。
 *
 * PinnedLogWindow の pointer ハンドラから DOM 非依存の算術だけを切り出したもの。
 * ハンドラ側は DOM の読み取り (rect / computed style) と反映 (inline style / move()) だけを
 * 担い、境界挙動の正しさはこのモジュールの単体テストで担保する。
 *
 * 不変条件: 左/上辺のリサイズでは反対辺 (右/下端) がアンカーとして固定される。
 * サイズを先にクランプしてから位置を逆算する。位置を先に動かすと min/max に当たった
 * 瞬間にアンカー辺がずれて window が滑る。
 */

/** リサイズハンドルの方位。CSS cursor と反対辺アンカーの導出キー。 */
export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** pointerdown 時の実測 rect のうち算術に必要な部分 (DOMRect 互換)。 */
export interface ResizeStartRect {
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface ResizeBounds {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** 上辺リサイズで上端が越えられない y 下限 (タイトルバー直下。ドラッグの y クランプと同値)。 */
  topMin: number;
}

/** 方位に応じて定義されるフィールドだけ返す。x / y は左/上辺リサイズでのみ動く。 */
export interface ResizeResult {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function deriveResize(
  dir: ResizeDirection,
  dx: number,
  dy: number,
  startRect: ResizeStartRect,
  bounds: ResizeBounds,
): ResizeResult {
  const { minWidth, maxWidth, minHeight, maxHeight, topMin } = bounds;
  const result: ResizeResult = {};
  if (dir.includes("e")) {
    result.width = clamp(startRect.width + dx, minWidth, maxWidth);
  }
  if (dir.includes("w")) {
    const width = clamp(startRect.width - dx, minWidth, maxWidth);
    result.width = width;
    result.x = startRect.right - width;
  }
  if (dir.includes("s")) {
    result.height = clamp(startRect.height + dy, minHeight, maxHeight);
  }
  if (dir.includes("n")) {
    // 上端は topMin (タイトルバー直下) で止める: 高さの上限を「下端アンカーから topMin まで」
    // に絞ることで、位置クランプではなくサイズクランプとして扱いアンカーを保つ
    const limit = Math.min(maxHeight, startRect.bottom - topMin);
    const height = clamp(startRect.height - dy, minHeight, limit);
    result.height = height;
    result.y = startRect.bottom - height;
  }
  return result;
}
