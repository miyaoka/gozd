/**
 * git graph のレーン色パレットと、RefBadge / line / dot で共有する OKLCH helper。
 *
 * `LANE_SPECS` は固定 8 色の cyclic palette。任意 2 レーンが同時描画されうるため、
 * 全 28 ペア (8C2) を「hue 差 60 度以上 or 明度差 0.05 以上」で識別可能に固定する。
 *
 * RefBadge は branch ref を「自分の lane と同じ hue」で描画して graph line と視覚的に
 * 揃える。local / synced は明色 (`laneTextColor` = full L)、remote は同 hue を低 L で
 * 描画 (`laneRemoteTextColor`) する。bg は lane hue を低 L / 低 C に倒した
 * `laneSubtleBgColor` を使い、subtle chip pattern を per-lane に展開する。
 *
 * 8 lane × 3 variant = 24 値を Tier 2 token として持つと alias 表が肥大化するため、
 * 動的計算色 (gozd-ui SKILL doc の inline style 例外 (c)) として扱い、ここの function
 * 経由で inline style に渡す運用にする。
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

function specFor(index: number): LaneSpec {
  return LANE_SPECS[index % LANE_SPECS.length];
}

/**
 * graph line / dot / RefBadge の local-branch text に使う「明色」。
 * graph line の draw color と一致するため、RefBadge と graph line の hue が同じになる。
 */
export function laneTextColor(index: number): string {
  const s = specFor(index);
  return `oklch(${s.l} ${s.c} ${s.h})`;
}

/**
 * RefBadge の subtle bg。lane hue を保ったまま L=0.27 / C=0.05 まで落として
 * dark bg (gray-1) 上で「色付きだが控えめ」な chip 面を作る。
 */
export function laneSubtleBgColor(index: number): string {
  const s = specFor(index);
  return `oklch(0.27 0.05 ${s.h})`;
}

/**
 * RefBadge の remote-branch text。lane hue を保ったまま L を local より約 0.18 下げ、
 * C を 0.6 倍に絞ることで「同じブランチの remote 側 = 一段 dim」を表現する。
 * local と remote が並んだとき、明度差で「ローカルが actionable、remote は参照」を視覚化。
 */
export function laneRemoteTextColor(index: number): string {
  const s = specFor(index);
  const dimL = Math.max(0.4, s.l - 0.18);
  const dimC = s.c * 0.6;
  return `oklch(${dimL} ${dimC} ${s.h})`;
}
