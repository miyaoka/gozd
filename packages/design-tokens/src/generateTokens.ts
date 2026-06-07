/*
 * gozd design tokens Tier 1 (primitives) を Adobe Leonardo の contrast-driven
 * algorithm で生成し、CSS file (dist/tokens.generated.css) として出力する。
 *
 * Tailwind v4 の `@theme inline` semantic alias 層は consumer 側 (renderer の
 * main.css) が定義する。この package は primitive 層のみを責任範囲とする:
 *   - gray 12-step solid + 12-step alpha (overlay 用)
 *   - intent hues (blue/red/green/amber/orange) 各 12-step solid
 *
 * Radix step → role 写像に揃えた WCAG2 contrast ratios:
 *   1     bg 自身
 *   2-5   bg / component bg (rest/hover/active)        ← subtle chip / active row
 *   6-8   border (subtle/interactive/strong)
 *   9-10  solid bg (rest/hover)                         ← CTA / badge 本体
 *   11    low-contrast text (WCAG2 8.0+)
 *   12    high-contrast text (WCAG2 14.0+)
 *
 * 再生成: pnpm install (prepare で自動) または pnpm --filter @gozd/design-tokens
 *         build。brand identity を変えたいときは BRAND を編集して再生成。
 *
 * ## Leonardo の使い方 — colorKeys に複数 anchor を渡す
 *
 * Leonardo の `Color({ colorKeys })` は anchor 配列の間を補間する。anchor が
 * 1 つだけだと内部で `[white, brand, black]` 構成になり、chroma-js OKLCH mode の
 * 補間が brand の chroma を全 step にほぼ保つ (低 step で subtle にならず、
 * 場合によっては overshoot)。
 *
 * 公式 README (`packages/contrast-colors/README.md`) の全例が 2 anchor を渡し、
 * 補間 spine を designer が制御する設計。Radix Dark 流の「低 step で chroma を
 * 絞る」curve を得るには、各 intent に **dark anchor + brand anchor + light anchor**
 * の 3 点を渡して chroma を物理的に下げる。
 *
 * dark / light anchor は brand hex から hue だけ取り、L と C を固定値で構築:
 *   - dark : oklch(0.18, 0.04, hue) — step 1-5 の chroma を絞る
 *   - light: oklch(0.93, 0.03, hue) — step 11-12 の chroma を絞る
 *
 * これで Leonardo は `[white, light, brand, dark, black]` の 5 点を spline 補間し、
 * 両端で chroma が tapered する Radix-style scale を出力する。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Color, BackgroundColor, Theme } from "@adobe/leonardo-contrast-colors";
import chroma from "chroma-js";

const OUTPUT_FILE = path.resolve(import.meta.dir, "../dist/tokens.generated.css");

const BRAND = {
  gray: "#888888",
  blue: "#3b82f6",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
} as const;

const STEP_RATIOS_BG = [1.1, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 4.5, 5.5, 8, 14];
const STEP_RATIOS_INTENT = [1.05, 1.15, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 4.5, 5.5, 8, 14];

/* BackgroundColor scale 上で bg が位置する % (dark UI のため低い値) */
const DARK_LIGHTNESS = 11;

/* intent ごとの chroma 絞り anchor の OKLCH パラメタ。
 * brand hex から hue を取り、L / C を固定値で構築する。 */
const DARK_ANCHOR_L = 0.18;
const DARK_ANCHOR_C = 0.04;
const LIGHT_ANCHOR_L = 0.93;
const LIGHT_ANCHOR_C = 0.03;

/* Leonardo の chroma-js module 拡張が型推論を unknown に倒すため明示 cast */
function oklchOf(hex: string): [number, number, number] {
  return (chroma(hex) as unknown as { oklch: () => [number, number, number] }).oklch();
}

function toOklch(hex: string): string {
  const [l, c, h] = oklchOf(hex);
  const lr = (Math.round(l * 1000) / 1000).toString();
  const cr = (Math.round(c * 1000) / 1000).toString();
  /* chroma=0 (pure gray) は NaN hue を 0 に正規化 */
  const hr = Number.isNaN(h) ? "0" : (Math.round(h * 10) / 10).toString();
  return `oklch(${lr} ${cr} ${hr})`;
}

/* brand hex の hue を保ったまま L/C を差し替えた anchor hex を生成。
 * これを Leonardo の colorKeys に追加して chroma curve を制御する。
 *
 * Leonardo 内蔵の chroma-js.d.ts shim が `@types/chroma-js` を shadow するため
 * `chroma.oklch(...)` の型が消える。`oklchOf` と同じ unknown cast で逃がす。
 * Leonardo の colorKeys は CssColor (RgbHexColor = `#${string}` の template literal)
 * を受けるが、chroma の .hex() は string を返すので narrow cast する。 */
function buildAnchor(brandHex: string, l: number, c: number): `#${string}` {
  const [, , h] = oklchOf(brandHex);
  const hue = Number.isNaN(h) ? 0 : h;
  const chromaCast = chroma as unknown as {
    oklch: (l: number, c: number, h: number) => { hex: () => string };
  };
  return chromaCast.oklch(l, c, hue).hex() as `#${string}`;
}

/* white overlay on bg で色 T を再現する alpha を計算
 * formula (linear RGB): T = white * a + bg * (1 - a) → a = (T - bg) / (1 - bg)
 * gray は無彩色なので lightness 1 channel で計算可能 */
function alphaForGray(target: string, bg: string): string {
  const t = oklchOf(target)[0];
  const b = oklchOf(bg)[0];
  const a = Math.max(0, Math.min(1, (t - b) / (1 - b)));
  return `oklch(1 0 0 / ${Math.round(a * 1000) / 1000})`;
}

/* gray は無彩色なので chroma curve 制御不要。単一 brand anchor で十分
 * (補間 chroma が全 step で 0 のままになる)。 */
const gray = new BackgroundColor({
  name: "gray",
  colorKeys: [BRAND.gray],
  colorSpace: "OKLCH",
  ratios: STEP_RATIOS_BG,
});

/* intent は dark/brand/light の 3 anchor を渡して chroma 両端 tapering を強制する。
 * 単一 anchor だと chroma が全 step で brand 並みに維持され、低 step が subtle に
 * ならない (PR #718 の元コードがこれで blue-3 が C=0.183 と他 intent の 1.4 倍出た)。 */
const intents = (["blue", "red", "green", "amber", "orange"] as const).map(
  (name) =>
    new Color({
      name,
      colorKeys: [
        buildAnchor(BRAND[name], DARK_ANCHOR_L, DARK_ANCHOR_C),
        BRAND[name],
        buildAnchor(BRAND[name], LIGHT_ANCHOR_L, LIGHT_ANCHOR_C),
      ],
      colorSpace: "OKLCH",
      ratios: STEP_RATIOS_INTENT,
    }),
);

/* gray を colors にも入れる: BackgroundColor は bg 単一点を提供するだけで、
 * gray scale (12 step) は contrastColors の colors array 経由でしか取れない
 * (Adobe Spectrum 公式 pattern) */
const theme = new Theme({
  colors: [gray, ...intents],
  backgroundColor: gray,
  lightness: DARK_LIGHTNESS,
  contrast: 1,
  output: "HEX",
  formula: "wcag2",
});

type ContrastGroup = { name: string; values: { value: string }[] };
const [bgEntry, ...groups] = theme.contrastColors as [
  { background: string },
  ...ContrastGroup[],
];

/* gray scale: step 1 = bg 自身、steps 2..12 = ratios の各点 */
const grayGroup = groups.find((g) => g.name === "gray");
if (grayGroup === undefined) throw new Error("Leonardo did not return gray group");
const grayHexes: string[] = [bgEntry.background, ...grayGroup.values.map((v) => v.value)];
if (grayHexes.length !== 12) throw new Error(`expected 12 gray steps, got ${grayHexes.length}`);

const lines: string[] = [
  `/* Auto-generated — do not edit. */`,
  `/* Tier 1: gozd design token primitives (Adobe Leonardo, dark mode) */`,
  ``,
  `:root {`,
  `  /* gray: 12-step solid */`,
];
for (let i = 0; i < grayHexes.length; i++) {
  lines.push(`  --gray-${i + 1}: ${toOklch(grayHexes[i])};`);
}
lines.push(``);
lines.push(`  /* gray: 12-step alpha (white overlay matched to gray scale) */`);
for (let i = 0; i < grayHexes.length; i++) {
  lines.push(`  --gray-a${i + 1}: ${alphaForGray(grayHexes[i], grayHexes[0])};`);
}

for (const intent of intents) {
  const group = groups.find((g) => g.name === intent.name);
  if (group === undefined) throw new Error(`missing ${intent.name} group`);
  const hexes = group.values.map((v) => v.value);
  if (hexes.length !== 12) throw new Error(`expected 12 ${intent.name} steps, got ${hexes.length}`);
  lines.push(``);
  lines.push(`  /* ${intent.name}: 12-step solid */`);
  for (let i = 0; i < hexes.length; i++) {
    lines.push(`  --${intent.name}-${i + 1}: ${toOklch(hexes[i])};`);
  }
}

lines.push(`}`);
lines.push(``);

await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await writeFile(OUTPUT_FILE, lines.join("\n"));
console.error(
  `generated ${grayHexes.length + intents.length * 12} primitives + ${grayHexes.length} alpha → ${OUTPUT_FILE}`,
);
