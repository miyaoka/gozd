/*
 * Tier 1 primitives を Adobe Leonardo の contrast-driven algorithm で生成し、
 * dist/tokens.generated.css として出力する。package の契約 (責務 / 利用側への要求 /
 * age scale の検証) は README.md。
 *
 * ## Leonardo の使い方 — colorKeys に複数 anchor を渡す
 *
 * Leonardo の `Color({ colorKeys })` は anchor 配列の間を補間する。anchor が
 * 1 つだけだと内部で `[white, brand, black]` 構成になり、chroma curve を
 * designer 側で制御できない。chroma-js OKLCH mode の補間が brand の chroma を
 * 全 step にほぼ保つため、低 step で subtle にならない (gamut の隅にある hue
 * では overshoot も起きる)。
 *
 * 公式 README (`packages/contrast-colors/README.md`) の `Color` 例は 2 anchor を
 * 渡し、補間 spine を designer が制御する設計を canonical pattern としている
 * (BackgroundColor のような無彩色 scale は単一 anchor で十分)。Radix Dark 流の
 * 「低 step で chroma を絞る」curve を得るには、各 intent に **dark anchor +
 * brand anchor + light anchor** の 3 点を渡して chroma を物理的に下げる。
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
import { deltaEOk, type Oklch } from "./colorMath";

const OUTPUT_FILE = path.resolve(import.meta.dir, "../dist/tokens.generated.css");

const BRAND = {
  gray: "#888888",
  blue: "#3b82f6",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
} as const;

/* bg に対する WCAG2 目標コントラスト比。Radix step → role 写像
 * (1 = bg 自身、2-5 = component bg rest/hover/active、6-8 = border、
 *  9-10 = solid bg、11 = low text、12 = high text) に揃えた値で、
 * step 11 / 12 のコントラスト保証はこの目標値から来る。
 * BG 側は step 1 が bg 自身のため ratios は 11 点 */
const STEP_RATIOS_BG = [1.1, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 4.5, 5.5, 8, 14];
const STEP_RATIOS_INTENT = [1.05, 1.15, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 4.5, 5.5, 8, 14];

/* age scale (相対日時の鮮度 4 帯) の個別設計値。hour / date 帯は生成 scale の step
 * (green 11 / gray 11) と同値で、day / week は人間が候補比較で選んだ値。
 * 帯の境界と表示単位は renderer の shared/time、role の意味は main.css が持ち、
 * 値と知覚検証はここが SSOT。
 *
 * day / week は dark UI 前提の手選び値。light theme を追加するときは .light scope の
 * 生成に乗らないため、この 2 値は再設計が必要。 */
const AGE_DAY: Oklch = [0.87, 0.155, 97];
const AGE_WEEK: Oklch = [0.74, 0.15, 52];

/* age scale の scale 内不変条件 (gozd-ui skill「文字色で段階 / カテゴリを区別するときの
 * 知覚下限」)。散在する小さい文字の絶対識別に必要な色名分離の下限で、違反は生成失敗 =
 * ビルド失敗として現れる (Leonardo の contrast-driven 生成と同じ by-construction 方針)。
 * 載る面での AA は利用側 (Tier 2 の配置) の知識であり、ここでは検証しない。面や値を
 * 変えるときは skill の規律に従い設計時に計算で検証する。 */
const AGE_MIN_PAIR_DELTA_E = 15;

/* BackgroundColor scale 上で bg が位置する % (dark UI のため低い値) */
const DARK_LIGHTNESS = 11;

/* intent ごとの chroma 絞り anchor の OKLCH パラメタ。
 * brand hex から hue を取り、L / C を固定値で構築する。 */
const DARK_ANCHOR_L = 0.18;
const DARK_ANCHOR_C = 0.04;
const LIGHT_ANCHOR_L = 0.93;
const LIGHT_ANCHOR_C = 0.03;

/* Leonardo 内蔵の chroma-js.d.ts shim が `@types/chroma-js` を shadow するため
 * chroma の instance method (.oklch()) と factory (chroma.oklch(L, C, H)) が
 * 型推論で unknown に倒れる。両 API を 1 箇所に集約して unknown cast を 1 度だけ書く。 */
const chromaApi = chroma as unknown as {
  (input: string): { oklch: () => [number, number, number] };
  oklch: (l: number, c: number, h: number) => { hex: () => string };
};

function oklchOf(hex: string): [number, number, number] {
  return chromaApi(hex).oklch();
}

/* 出力と同じ丸めの OKLCH triple。知覚検証は出荷される丸め後の値に対して行う */
function roundedOklchOf(hex: string): Oklch {
  const [l, c, h] = oklchOf(hex);
  return [
    Math.round(l * 1000) / 1000,
    Math.round(c * 1000) / 1000,
    /* chroma=0 (pure gray) は NaN hue を 0 に正規化 */
    Number.isNaN(h) ? 0 : Math.round(h * 10) / 10,
  ];
}

function oklchToCss([l, c, h]: Oklch): string {
  return `oklch(${l} ${c} ${h})`;
}

function toOklch(hex: string): string {
  return oklchToCss(roundedOklchOf(hex));
}

/* brand hex の hue を保ったまま L/C を差し替えた anchor hex を生成。
 * これを Leonardo の colorKeys に追加して chroma curve を制御する。
 * Leonardo の colorKeys は CssColor (RgbHexColor = `#${string}` の template literal)
 * を受けるが、chroma の .hex() は string を返すので narrow cast する。 */
function buildAnchor(brandHex: string, l: number, c: number): `#${string}` {
  const [, , h] = oklchOf(brandHex);
  const hue = Number.isNaN(h) ? 0 : h;
  return chromaApi.oklch(l, c, hue).hex() as `#${string}`;
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
const [bgEntry, ...groups] = theme.contrastColors as [{ background: string }, ...ContrastGroup[]];

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

let greenHexes: string[] | undefined;
for (const intent of intents) {
  const group = groups.find((g) => g.name === intent.name);
  if (group === undefined) throw new Error(`missing ${intent.name} group`);
  const hexes = group.values.map((v) => v.value);
  if (hexes.length !== 12) throw new Error(`expected 12 ${intent.name} steps, got ${hexes.length}`);
  if (intent.name === "green") greenHexes = hexes;
  lines.push(``);
  lines.push(`  /* ${intent.name}: 12-step solid */`);
  for (let i = 0; i < hexes.length; i++) {
    lines.push(`  --${intent.name}-${i + 1}: ${toOklch(hexes[i])};`);
  }
}

/* age 帯の値を組み立て、scale 内不変条件を検証してから primitive として出力する */
if (greenHexes === undefined) {
  throw new Error("green scale missing for age bands");
}
const ageBands: Record<string, Oklch> = {
  hour: roundedOklchOf(greenHexes[10]),
  day: AGE_DAY,
  week: AGE_WEEK,
  date: roundedOklchOf(grayHexes[10]),
};
const bandEntries = Object.entries(ageBands);
for (const [i, [nameA, a]] of bandEntries.entries()) {
  for (const [nameB, b] of bandEntries.slice(i + 1)) {
    const d = deltaEOk(a, b);
    if (d < AGE_MIN_PAIR_DELTA_E) {
      throw new Error(
        `age scale: ${nameA}/${nameB} pair ΔE ${d.toFixed(1)} < ${AGE_MIN_PAIR_DELTA_E}`,
      );
    }
  }
}
lines.push(``);
lines.push(`  /* age scale: 相対日時の鮮度 4 帯 (hour = green-11、date = gray-11 と同値)。`);
lines.push(`     全ペア ΔE >= ${AGE_MIN_PAIR_DELTA_E} を生成時に検証済み */`);
for (const [name, triple] of bandEntries) {
  lines.push(`  --age-${name}: ${oklchToCss(triple)};`);
}

lines.push(`}`);
lines.push(``);

await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await writeFile(OUTPUT_FILE, lines.join("\n"));
console.error(
  `generated ${grayHexes.length + intents.length * 12} primitives + ${grayHexes.length} alpha → ${OUTPUT_FILE}`,
);
