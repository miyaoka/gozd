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
