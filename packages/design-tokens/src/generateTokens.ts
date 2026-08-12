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
import { deltaEOk, wcagContrast, type Oklch } from "./colorMath";

const OUTPUT_FILE = path.resolve(import.meta.dir, "../dist/tokens.generated.css");

/* brand anchor。solid step を暗くすると Leonardo の補間で彩度も落ちる (明度を下げると brand
 * anchor から離れるため)。blue はその目減りを brand 側の彩度で戻してあり、値は sRGB gamut の
 * 上限 — これ以上上げても hex 化でクリップされて同じ色になる。他の hue も同じ目減りを受けるが
 * 補正していない。 */
const BRAND = {
  gray: "#888888",
  blue: "#1f7dff",
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

/* intent の solid step (9-10) を縛るのは bg との差ではなく **面に載る前景** で、必要な向きが
 * 前景の明暗で逆になる。白前景の面は暗くないと文字が沈み、暗前景の面は明るくないと文字が沈む。
 * 1 本の ratios では両立しないため、前景の明暗で 2 系統に分ける。
 *
 * どちらを使うかは「その面に文字を載せるか、載せるならどちらの前景か」で決まる Tier 2 の
 * 配置知識なので、hue ではなく前景で命名する (hue と前景の対応が変わっても命名が嘘にならない)。 */

/* 白前景を載せる面。取りうる範囲は上下から挟まれる。
 *
 * 上限は前景から決まる。白と bg の比は 16.85:1 で固定なので、白前景が AA (4.5:1) を保てる面は
 * bg 比 3.74 以下に限られる。bg 比 4.5 を狙っていた頃はここを越えており、白前景が 3.7:1 まで
 * 落ちて blue / red の両方で AA を割っていた。
 *
 * 下限は面自体の識別で、bg から 3:1 離れる必要がある (1.4.11)。3.0〜3.74 の範囲で面の視認性が
 * 最も高い 3.7 を取る。
 *
 * この帯の制約は rest だけでなく **solid として使う全 step** に掛かる。hover を明るい側へ
 * 動かせないのはそのためで、上限 3.74 と rest 3.7 の間に余地が無い。使う step の集合は
 * SOLID_STEPS が持ち、生成時に検証する。border 帯 (6-8) は単調性を保つために追随させる。 */
const STEP_RATIOS_ON_LIGHT_FG = [1.05, 1.15, 1.3, 1.5, 1.8, 2.1, 2.5, 3.1, 3.7, 4.6, 8, 14];

/* 暗前景 (gray-1) を載せる面。前景が bg と同じ色なので、bg に対する比がそのまま前景の
 * contrast になる。AA を満たすには 4.5 を上回る必要があり、丸めを踏まないよう 4.6 を取る。 */
const STEP_RATIOS_ON_DARK_FG = [1.05, 1.15, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 4.6, 5.5, 8, 14];

/* hue → 前景系統。solid に文字を載せない hue (green の success 用途 / orange) も、同じ役割の
 * 仲間 (channel-dev は green-9 に白文字、warning-strong は warning と対) に合わせて選ぶ。 */
const INTENT_RATIOS = {
  blue: STEP_RATIOS_ON_LIGHT_FG,
  red: STEP_RATIOS_ON_LIGHT_FG,
  green: STEP_RATIOS_ON_LIGHT_FG,
  amber: STEP_RATIOS_ON_DARK_FG,
  orange: STEP_RATIOS_ON_DARK_FG,
} as const;

/* solid 面に載せる前景。面と対でしか意味を持たないため、面を作る側が owner になり、値そのものを
 * primitive として出す。Tier 2 はそれを参照するだけで分類を持たない — 同じ分類を 2 箇所に置くと、
 * 片方だけ変えたときに contrast が無言で壊れ、型もテストも掛からない。 */
const INTENT_ON_SOLID = {
  blue: "light",
  red: "light",
  green: "light",
  amber: "dark",
  orange: "dark",
} as const;

/* solid 面として使う step。ここに挙げた step すべてで前景が AA を満たすことを生成時に検証する。
 * rest だけ見ると hover が無言で割れる（step を跨いで同じ前景を載せるため）。
 *
 * 白前景の面は hover を **暗い側** の step 8 から取る。step 10 (bg 比 4.6) に置けないのは、
 * 白前景が AA を保てる上限 3.74 を越えるためで、Radix の「step 10 = より明るい hover」は
 * light theme の前提。暗い bg に白前景を載せる構成では明度を上げる向き自体が成立しない
 * (Apple の塗りボタンも dark 背景で hover をほぼ動かさず、押下はむしろ暗くする)。
 *
 * 暗前景の面は rest だけ。前景が bg と同色なので、暗い側へ動かすと前景との差が縮んで割れる
 * (step 8 は 3.50:1)。hover を要求する用途が出た時点で、明るい側の step で帯を広げる。 */
const SOLID_STEPS: Record<keyof typeof INTENT_ON_SOLID, { rest: number; hover?: number }> = {
  blue: { rest: 9, hover: 8 },
  red: { rest: 9, hover: 8 },
  /* solid の hover を要求する用途がまだ無い hue は rest だけ持つ。出しておくと使われない
     role が増え、どれが検証済みの組かが読み取れなくなる */
  green: { rest: 9 },
  amber: { rest: 9 },
  orange: { rest: 9 },
};

/* hover の層に使う alpha の step。値は role (`--surface-hover-layer`) として出し、Tier 2 は
 * それを参照するだけにする — Tier 2 が別の alpha を選べると、面の上限判定の前提が黙って崩れる。
 * 面の上限判定はこの層を重ねた後の色で行う (載りうる最も明るい面は gray の step だけでは
 * 表せない)。solid の輪郭は下限ぎりぎりなので、濃くすると assert が落ちる。 */
const HOVER_ALPHA_STEP = 2;

/* solid 面が載る最も明るい下地 (panel)。面自体が下地から 3:1 離れていないと輪郭を失う (1.4.11)。
 *
 * この要件は **rest にだけ**掛ける。hover は状態の識別に必要な情報ではなく supplemental な
 * 変化なので、面そのものに 3:1 は要求されない (W3C の Understanding 1.4.11)。hover にも掛けると、
 * 白前景 AA を保つために暗くした面と両立せず、値のチューニングでは抜けられない。
 *
 * element (gray-3) 以上の面は上限に取れない。白と bg の比が固定である以上、白前景 AA を保てる
 * 面の明るさには上限があり、その面が element の上で 3:1 を得ることは数学的に成立しないため。 */
const SOLID_MAX_SURFACE_STEP = 2;

/* focus ring に使う step と、ring が載りうる最も明るい面。ring は interactive な面の縁に
 * 描かれるため、bg ではなく **その面** に対して 3:1 を要求される (1.4.11)。border 帯 (step 8) は
 * bg より明るい面の上で 3:1 を割るので使えない。
 * 面の上限は element-active (gray-5) を取る。focusable な button の背景として使われており、
 * hover の層が element に重なった面もこの明るさに達する。 */
const RING_STEP = 11;
const RING_MAX_SURFACE_STEP = 5;

/* 前景の実体。light は純白、dark は bg と同色 (gray scale の 1 段目) を使う */
const ON_SOLID_LIGHT: Oklch = [1, 0, 0];

/** solid 面と前景 / ring と面の関係。破れたら生成を失敗させる (age scale の ΔE 検証と同じ流儀で、
 * 壊れた token を出荷させない) */
function assertContrast(label: string, got: number, min: number): void {
  if (got < min) {
    throw new Error(`${label}: contrast ${got.toFixed(2)} < ${min}`);
  }
}

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
  (input: string): { oklch: () => [number, number, number]; rgb: () => [number, number, number] };
  oklch: (l: number, c: number, h: number) => { hex: () => string };
  rgb: (r: number, g: number, b: number) => { hex: () => string };
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

/* white overlay on bg で色 T を再現する alpha を計算。
 *
 * ブラウザは gamma sRGB のチャネル値で合成する (composited = 255 * a + bg * (1 - a)) ため、
 * 同じ空間で解く。OKLCH の L や linear RGB で解くと空間が違い、生成した alpha を重ねても
 * 目標の step にならない。gray は無彩色なので 1 channel で足りる。 */
function alphaForGray(target: string, bg: string): number {
  const [t] = chromaApi(target).rgb();
  const [b] = chromaApi(bg).rgb();
  const a = Math.max(0, Math.min(1, (t - b) / (255 - b)));
  return Math.round(a * 1000) / 1000;
}

/** 白の層を重ねた結果。合成はブラウザと同じ gamma sRGB で行う */
function overlayWhite(baseHex: string, alpha: number): Oklch {
  const mix = (c: number) => 255 * alpha + c * (1 - alpha);
  const [r, g, b] = chromaApi(baseHex).rgb();
  return roundedOklchOf(chromaApi.rgb(mix(r), mix(g), mix(b)).hex());
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
const INTENT_NAMES = ["blue", "red", "green", "amber", "orange"] as const;

const intents = INTENT_NAMES.map(
  (name) =>
    new Color({
      name,
      colorKeys: [
        buildAnchor(BRAND[name], DARK_ANCHOR_L, DARK_ANCHOR_C),
        BRAND[name],
        buildAnchor(BRAND[name], LIGHT_ANCHOR_L, LIGHT_ANCHOR_C),
      ],
      colorSpace: "OKLCH",
      ratios: INTENT_RATIOS[name],
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
  lines.push(`  --gray-a${i + 1}: oklch(1 0 0 / ${alphaForGray(grayHexes[i], grayHexes[0])});`);
}

/* 暗い前景は bg と同色。gray scale の 1 段目がそれにあたる */
const onSolidDark = roundedOklchOf(grayHexes[0]);

/* 面の上限は「上限 step が hover している状態」。hover は層なので、gray の step だけでは
   載りうる最も明るい面を表せない */
const hoverAlpha = alphaForGray(grayHexes[HOVER_ALPHA_STEP - 1], grayHexes[0]);
const maxSurfaceHovered = overlayWhite(grayHexes[SOLID_MAX_SURFACE_STEP - 1], hoverAlpha);
const ringMaxSurfaceHovered = overlayWhite(grayHexes[RING_MAX_SURFACE_STEP - 1], hoverAlpha);

let greenHexes: string[] | undefined;
let blueHexes: string[] | undefined;
for (const name of INTENT_NAMES) {
  const group = groups.find((g) => g.name === name);
  if (group === undefined) throw new Error(`missing ${name} group`);
  const hexes = group.values.map((v) => v.value);
  if (hexes.length !== 12) throw new Error(`expected 12 ${name} steps, got ${hexes.length}`);
  if (name === "green") greenHexes = hexes;
  if (name === "blue") blueHexes = hexes;

  /* solid として使う全 step で前景が AA を満たすことを保証する。rest だけ見ると hover が
     無言で割れる（step を跨いで同じ前景を載せるため） */
  const onSolid = INTENT_ON_SOLID[name] === "light" ? ON_SOLID_LIGHT : onSolidDark;
  const roles = SOLID_STEPS[name];
  const solidSteps = roles.hover === undefined ? [roles.rest] : [roles.rest, roles.hover];

  /* 前景は rest / hover の両方で AA を要求する。文字を読むのは hover 中も同じで、
     step を跨いで同じ前景が載るため */
  for (const step of solidSteps) {
    assertContrast(
      `${name}-${step} と on-solid`,
      wcagContrast(onSolid, roundedOklchOf(hexes[step - 1])),
      4.5,
    );
  }
  /* 面の輪郭は rest にだけ要求する (hover は supplemental)。ただし下地の側は hover しうるので、
     上限 step に層を重ねた色を実際の下地として見る */
  assertContrast(
    `${name}-${roles.rest} と hover 中の gray-${SOLID_MAX_SURFACE_STEP}`,
    wcagContrast(roundedOklchOf(hexes[roles.rest - 1]), maxSurfaceHovered),
    3,
  );

  lines.push(``);
  lines.push(`  /* ${name}: 12-step solid */`);
  for (let i = 0; i < hexes.length; i++) {
    lines.push(`  --${name}-${i + 1}: ${toOklch(hexes[i])};`);
  }
  /* 面そのものも role として出す。どの step を solid に使うかを Tier 2 が選べる状態だと、
     検証されていない step を指しても生成時に気付けない */
  lines.push(`  /* solid 面と、その面に載せる前景。検証済みの組を role として出す */`);
  lines.push(`  --${name}-solid: ${toOklch(hexes[roles.rest - 1])};`);
  if (roles.hover !== undefined) {
    lines.push(`  --${name}-solid-hover: ${toOklch(hexes[roles.hover - 1])};`);
  }
  lines.push(`  --${name}-on-solid: ${oklchToCss(onSolid)};`);
}

/* focus ring。interactive な面の上に描かれるので、bg ではなく載りうる最も明るい面に対して
   3:1 を要求する */
if (blueHexes === undefined) {
  throw new Error("blue scale missing for focus ring");
}
const ringColor = roundedOklchOf(blueHexes[RING_STEP - 1]);
assertContrast(
  `ring と gray-${RING_MAX_SURFACE_STEP}`,
  wcagContrast(ringColor, ringMaxSurfaceHovered),
  3,
);
lines.push(``);
lines.push(`  /* focus ring: gray-${RING_MAX_SURFACE_STEP} までの面に対して 3:1 を満たす */`);
lines.push(`  --ring: ${oklchToCss(ringColor)};`);
lines.push(``);
lines.push(
  `  /* hover の層。面の上限判定がこの値を前提に組まれているため、利用側で選び直さない */`,
);
lines.push(`  --surface-hover-layer: var(--gray-a${HOVER_ALPHA_STEP});`);

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
