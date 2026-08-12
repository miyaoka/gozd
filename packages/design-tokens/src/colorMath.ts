import chroma from "chroma-js";

/* Leonardo 内蔵の chroma-js.d.ts shim が `@types/chroma-js` を shadow するため
 * 型推論が unknown に倒れる（generateTokens.ts の chromaApi と同じ事情）。
 * 必要な API を 1 箇所に集約して unknown cast を 1 度だけ書く。 */
interface ChromaColor {
  oklab: () => [number, number, number];
  hex: () => string;
  clipped: () => boolean;
}
const chromaApi = chroma as unknown as {
  (input: string): ChromaColor;
  oklch: (l: number, c: number, h: number) => ChromaColor;
  contrast: (a: ChromaColor, b: ChromaColor) => number;
};

/** sRGB gamut 外の設計値は clamp で画面と検証値が乖離するため、fallback せずエラーにする。
 * chroma の clipped() は limit 前の生値を見るため、境界ちょうどの値 (純白等) も変換誤差で
 * gamut 外判定になりうる */
function toColor(c: Oklch): ChromaColor {
  const color = chromaApi.oklch(...c);
  if (color.clipped()) throw new Error(`out of sRGB gamut: oklch(${c.join(" ")})`);
  return color;
}

/** 8bit 量子化後 (実際に描画される値) の色。判定は量子化後の値に対して行い、
 * 境界近傍で「検証は通るが画面は割る」ずれを作らない */
function quantized(c: Oklch): ChromaColor {
  return chromaApi(toColor(c).hex());
}

/** gamut 判定を伴わない量子化。gamut 内にあることが既に分かっている色どうしの比較に使う。
 * `clipped()` は limit 前の生値を見るため、純白のような境界ちょうどの値を gamut 外と誤検出する
 * (`toColor` の doc が予告している挙動)。設計値そのものの妥当性は生成側が別に担保する。 */
function quantizedInGamut(c: Oklch): ChromaColor {
  return chromaApi(chromaApi.oklch(...c).hex());
}

/** oklch の成分 3 値（L, C, hue deg）。CSS の `oklch(L C h)` と同順 */
export type Oklch = [number, number, number];

/**
 * OKLab ユークリッド距離 ×100。
 *
 * gozd-ui skill の「文字色で段階 / カテゴリを区別するときの知覚下限」が定める尺度で、
 * 色名分離の下限はペア ΔE ≥ 15。色空間変換は chroma-js に委譲し、自前の変換行列を
 * 持たない（検証器そのものが未検証の再実装になるのを避ける）。
 */
export function deltaEOk(a: Oklch, b: Oklch): number {
  const [l1, a1, b1] = quantized(a).oklab();
  const [l2, a2, b2] = quantized(b).oklab();
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/**
 * WCAG2 のコントラスト比。
 *
 * 面と、その面に載る前景 / 隣接面との関係を判定するための尺度。text は 4.5、UI 部品や
 * 図形は 3 が下限（WCAG 1.4.3 / 1.4.11）。`deltaEOk` と同じく量子化後の値で判定し、
 * 「検証は通るが画面は割る」ずれを作らない。相対輝度の算出は chroma-js に委譲する。
 */
export function wcagContrast(a: Oklch, b: Oklch): number {
  return chromaApi.contrast(quantizedInGamut(a), quantizedInGamut(b));
}
