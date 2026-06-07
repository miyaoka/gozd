# @gozd/design-tokens

gozd の Tier 1 (primitives) design tokens を Adobe Leonardo の contrast-driven
algorithm で生成する。出力は `dist/tokens.generated.css` に `:root { --gray-1: ...; ... }`
形式の CSS variable として書き出される。

## 使い方

renderer 側 (consumer) の Tailwind v4 entry CSS で `@import` する:

```css
@import "tailwindcss";
@import "@gozd/design-tokens/tokens.css";

@theme inline {
  /* Tier 2: semantic alias を consumer 側で定義 */
  --color-background: var(--gray-1);
  --color-panel: var(--gray-2);
  /* ... */
}
```

## tier 分離の責任

| Tier                      | 責任                             | 配置                                 |
| ------------------------- | -------------------------------- | ------------------------------------ |
| Tier 1 (primitives)       | OKLCH 物理値、12-step scale      | この package (`@gozd/design-tokens`) |
| Tier 2 (semantic aliases) | role 名 → primitive の写像       | renderer の `main.css @theme inline` |
| Tier 3 (element defaults) | UA stylesheet 上書き / scrollbar | renderer の `main.css @layer base`   |

## token 一覧

| 名前             | step  | role                                          |
| ---------------- | ----- | --------------------------------------------- |
| `--gray-1..12`   | solid | app bg / component bg / border / solid / text |
| `--gray-a1..a12` | alpha | overlay / chrome (白 alpha)                   |
| `--blue-1..12`   | solid | intent: primary / info                        |
| `--red-1..12`    | solid | intent: destructive                           |
| `--green-1..12`  | solid | intent: success                               |
| `--amber-1..12`  | solid | intent: warning                               |
| `--orange-1..12` | solid | intent: warning-strong                        |

Radix の step → role 写像に従う:

- 1-2 app / subtle bg
- 3-5 component bg (rest / hover / active)
- 6 subtle border (non-interactive)
- 7 interactive border
- 8 strong border / focus ring
- 9-10 solid bg (rest / hover)
- 11 low-contrast text (WCAG2 8.0+)
- 12 high-contrast text (WCAG2 14.0+)

## 再生成

`pnpm install` で `prepare` script が自動実行される。brand を変えたいときは
`src/generateTokens.ts` の `BRAND` を編集して再 `pnpm install` (または
`pnpm --filter @gozd/design-tokens build`)。

## なぜ Leonardo か

contrast-driven generator なので、target contrast (WCAG2 / APCA) を **入力に指定**
すると、その contrast を満たす色を逆算する。step 11 が WCAG2 8.0、step 12 が 14.0
を確実に満たすため、APCA Lc 60/90 に近い結果になる。生 OKLCH を手書きすると
gamut 上の chroma 限界 / contrast 検証が手動になり破綻しやすい。

### colorKeys は複数 anchor を渡す (canonical pattern)

Leonardo の `Color({ colorKeys })` に **単一 anchor** を渡すと、内部で
`[white, brand, black]` 構成となり chroma curve を designer が制御できない。
低 step (subtle bg 用途) で brand の chroma がほぼそのまま維持され、Radix Dark 流の
「低 step で chroma を絞る」curve にならない (gamut の隅にある hue では overshoot
も起きる)。`packages/contrast-colors/README.md` の `Color` 例も全て 2+ anchor。

本 generator では各 intent に `[dark_anchor, brand, light_anchor]` の 3 anchor を渡す。
dark / light anchor は brand hex の hue を保ったまま L=0.18 C=0.04 (dark) /
L=0.93 C=0.03 (light) の固定 OKLCH を `chroma.oklch().hex()` で構築する。Leonardo は
`[white, light, brand, dark, black]` の 5 点 spline 補間に切り替わり、両端で chroma が
tapered する Radix-style scale を出力する。

> [!NOTE]
> dark / light anchor の (L, C) は全 intent 共通の固定値であり、hue ごとの OKLCH gamut
> 境界に最適化されていない。実用上は問題ない出力に揃うが、Radix Dark scale そのものとは
> 厳密一致しない (Radix は手作業で hue ごとに別 curve を持つ)。将来 hue 固有のチューニングが
> 必要になったら、`BRAND` を `{hex, darkAnchor, lightAnchor}` の triple に拡張する
> 構造に進化させる。BackgroundColor (gray) は無彩色なので単一 anchor のままで十分。
