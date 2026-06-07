/**
 * git graph のレーン色パレット。graph line / dot の draw color (`colorFor`) で使う。
 *
 * `LANE_SPECS` は固定 8 色の cyclic palette。任意 2 レーンが同時描画されうるため、
 * 全 28 ペア (8C2) を「hue 差 60 度以上 or 明度差 0.05 以上」で識別可能に固定する。
 *
 * RefBadge は branch ref の色を current / default / other の 3 カテゴリで Tier 2 token (warning /
 * primary-subtle / success-subtle 等) に固定するため、graph line の lane 色とは別経路。
 */

type LaneSpec = { readonly l: number; readonly c: number; readonly h: number };

/** lane 0 = HEAD 予約色 (teal)。他は色相回りで識別性最大化 */
const LANE_SPECS: readonly LaneSpec[] = [
  { l: 0.74, c: 0.1, h: 175 } /* teal (HEAD reserved) */,
  { l: 0.65, c: 0.13, h: 247 } /* blue */,
  { l: 0.72, c: 0.13, h: 327 } /* purple */,
  { l: 0.62, c: 0.1, h: 51 } /* orange */,
  { l: 0.8, c: 0.13, h: 105 } /* yellow */,
  { l: 0.55, c: 0.16, h: 22 } /* red */,
  { l: 0.6, c: 0.12, h: 137 } /* green */,
  { l: 0.86, c: 0.07, h: 224 } /* light blue */,
];

/**
 * graph line / dot の draw color。
 */
export function laneTextColor(index: number): string {
  const s = LANE_SPECS[index % LANE_SPECS.length];
  return `oklch(${s.l} ${s.c} ${s.h})`;
}
