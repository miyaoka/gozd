---
name: gozd-ui
description: gozd の renderer (Vue + Tailwind v4) で UI を書く / 直すときの規律。3-tier design token system (primitives → semantic alias → element default)。Adobe Leonardo で生成した OKLCH 12-step を Tier 1 として持ち、Tier 2 で role-based semantic alias (`panel` / `element` / `primary` 等) を generate。生 Tailwind palette と primitive 直参照は ESLint で error。Vue SFC / Tailwind class / `apps/renderer/src/assets/main.css` を触る作業すべてに自動適用される。
---

# gozd-ui — Vue + Tailwind v4 design rules

renderer (`apps/renderer`) の UI を書く / 直すときの判断基準。色 / token は semantic alias だけを使い、primitive 直参照や raw palette は **構造的に書けない** (ESLint error)。

## 3-tier token system

```text
Tier 1 (primitives, :root)        ← @gozd/design-tokens package (prepare で build)
  --gray-1..12, --gray-a1..a12
  --blue-1..12, --red-1..12, --green-1..12, --amber-1..12, --orange-1..12

Tier 2 (semantic aliases, @theme inline)  ← renderer main.css、utility 生成、role 名
  --color-background, --color-panel, --color-element, --color-element-hover, ...
  --color-primary, --color-destructive, --color-success, --color-warning, ...

Tier 3 (element defaults, @layer base)    ← renderer main.css
  body / button / dialog / scrollbar
```

SSOT:

- Tier 1 primitives: `@gozd/design-tokens` package が prepare 時に `dist/tokens.generated.css` を生成。**手書き禁止**。brand を変えたいときは `packages/design-tokens/src/generateTokens.ts` の `BRAND` を編集して `pnpm install` (prepare で自動再生成)
- Tier 2/3: `apps/renderer/src/assets/main.css` (`@theme inline` semantic alias + `@layer base` element default)

semantic alias / element default は `@theme inline` / `@layer base` 内。不足したら raw に逃げず token を追加する。

## 静的チェック (lint で error)

以下は AI / 人間どちらが書いても build error。SKILL 規律ではなく機械強制 (constraint over determinism)。

| 違反                                            | ルール                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| 生 Tailwind palette (`bg-zinc-800` 等)          | `gozd/no-raw-tailwind-palette` (utility 形)               |
| 生 palette CSS var (`var(--color-zinc-800)`)    | `gozd/no-raw-tailwind-palette` (CSS var 形)               |
| primitive 直参照 (`var(--gray-3)` 等)           | `gozd/no-raw-tailwind-palette` (primitive var 形)         |
| 未定義 class (typo)                             | `better-tailwindcss/no-unknown-classes`                   |
| `w-N h-N` / `space-y-*` / `truncate` 等の正規化 | `better-tailwindcss/enforce-canonical-classes` (fix mode) |

primitive utility (`bg-gray-3` 等) は Tailwind が utility 化していない (primitive は `:root` で `@theme` 経由していない) ため、自動的に `no-unknown-classes` で弾かれる。

以下から先は人間 / AI **判断** が要る規律のみ。

## Semantic token reference (Tier 2)

### Surface (gray step 1-5)

| 用途                             | utility             |
| -------------------------------- | ------------------- |
| ページ背景                       | `bg-background`     |
| 既定 panel / card / dialog 内側  | `bg-panel`          |
| component bg (rest)              | `bg-element`        |
| component bg (hover)             | `bg-element-hover`  |
| component bg (active / selected) | `bg-element-active` |

`hover:bg-element-hover` は generic hover overlay の正規 pattern (旧 `hover:bg-accent` 相当)。selected / pressed は `bg-element-active` (旧 `bg-accent-strong` 相当)。

### Border (gray step 6-8)

| 用途                      | utility                |
| ------------------------- | ---------------------- |
| 同色面の弱い区切り        | `border-border-subtle` |
| 既定の interactive border | `border-border`        |
| 強調 outline / focus 兄弟 | `border-border-strong` |

### Text (gray step 9 / 11 / 12)

| 用途                                                                 | utility                 |
| -------------------------------------------------------------------- | ----------------------- |
| 本文 / heading (high contrast)                                       | `text-foreground`       |
| secondary text / placeholder                                         | `text-foreground-low`   |
| de-emphasized state / inactive item / disabled                       | `text-foreground-muted` |
| 強調は font-weight / size で表現する (旧 `foreground-strong` は廃止) | —                       |
| dark UI 上の chrome indicator (強)                                   | `bg-foreground`         |
| dark UI 上の chrome indicator (弱、非アクティブ playhead 等)         | `bg-foreground-low`     |

`text-foreground-muted` は Primer "NEVER use opacity for disabled" 規律に従う dim text / disabled 用 solid token。alpha modifier (`text-*/60`、`disabled:opacity-N` 等) で代用しない。disabled 状態の bg は `bg-element`、border は `border-border-subtle` を併用する。

### Intent (primary / destructive / success / warning / warning-strong / info)

各 intent は最大 6 token を持つ:

| token suffix            | 用途                                               | 例                                           |
| ----------------------- | -------------------------------------------------- | -------------------------------------------- |
| `<intent>`              | solid bg (step 9)                                  | `bg-primary`, `bg-destructive`               |
| `<intent>-hover`        | solid bg hover (step 10)                           | `hover:bg-primary-hover`                     |
| `<intent>-subtle`       | subtle bg (step 3、intent 性を保った dim 面)       | `bg-destructive-subtle`, `bg-success-subtle` |
| `<intent>-subtle-hover` | subtle bg hover (step 4、primary のみ提供)         | `hover:bg-primary-subtle-hover`              |
| `<intent>-text`         | low-contrast text on neutral / subtle bg (step 11) | `text-primary-text`, `text-destructive-text` |
| `<intent>-foreground`   | text on `<intent>` solid bg                        | `text-primary-foreground` (on `bg-primary`)  |

`-subtle-hover` は active row の hover で必要になった `primary` のみ提供。他 intent は use case が出た時点で追加する (YAGNI)。`warning-strong-subtle` も同様に未利用のため未定義 (subtle banner として warning と区別する用途が無い)。

`info` は text-only (solid なし、blue step 11 を借用)。warning / warning-strong は light yellow / mid-orange のため `*-foreground` は dark (gray-1)。

### Intent 利用パターン

| パターン      | 構成                                                         | 用途                                                                                                             |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| solid button  | `bg-<intent>` + `text-<intent>-foreground`                   | CTA / 主要 action (submit、destructive confirm)                                                                  |
| subtle chip   | `bg-<intent>-subtle` + `text-<intent>-text`                  | tag ref、icon-only state chip、diff line bg、user message bubble (branch ref は lane 色 = `graphColors.ts` 経由) |
| subtle banner | `bg-<intent>-subtle` + `border-<intent>` + `text-foreground` | error toast 本文、長文を含む intent 通知 (本文 neutral text + intent 色は border / icon に逃がす)                |
| active row    | `bg-<intent>-subtle` (+ `hover:bg-<intent>-subtle-hover`)    | 選択中の row / commit                                                                                            |
| text-only     | `text-<intent>-text`                                         | 状態文言、icon-only badge                                                                                        |

chip と banner の使い分け: 本文が短く intent 色で塗っても可読性が落ちないなら chip。本文に長文や cause 詳細を載せて neutral 高 contrast text が必要なら banner。

> [!CAUTION]
> 「subtle chip = `bg-<intent>/15 text-<intent>-text`」は alpha hack で **廃止**。任意 bg 上で contrast が崩れる ([Improta 3 大禁忌](https://designtokens.substack.com/p/transparency-in-color-tokens) の 1 つ)。`<intent>-subtle` (= step 3 solid) を使う ([Radix canonical pattern](https://www.radix-ui.com/colors/docs/overview/aliasing) と一致)。

### Overlay / Focus ring

| 用途                                | utility      |
| ----------------------------------- | ------------ |
| dialog / popover backdrop           | `bg-overlay` |
| focus ring (form input + container) | `ring-ring`  |

### Alpha (透過) の使い分け

業界 (Radix / shadcn v4 / Material 3 / Primer / Spectrum) は alpha token を完全廃止せず、用途を限定して使う:

| 用途                                                            | alpha OK?      | 規律                                                                                                                                                                                 |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dialog / popover backdrop                                       | ✅ 使う        | `bg-overlay` (黒 alpha 0.5)。下のコンテンツを意図的に見せる UX 要件                                                                                                                  |
| scrollbar thumb (任意 bg に乗る要素)                            | ✅ 使う        | `--color-scrollbar-thumb` が `--gray-a6` 経由で alpha 持つ                                                                                                                           |
| shadow (`box-shadow`)                                           | ✅ 使う        | 物理シミュレーション。solid 不可                                                                                                                                                     |
| reveal-on-hover / -focus transition (`opacity-0 → 100`)         | ✅ 使う        | menu icon 等を hover で出す表現。`group-hover/*:opacity-100` の per-element transition で solid 代替不能                                                                             |
| コンテンツ全体の dim (focus 外 pane / 非 actionable data state) | ✅ 使う (限定) | TerminalLeaf の非 focused leaf、PrPickerDialog の `isDraft` row 等、子孫 element の色を個別 token で書き換えるのが現実的でないケース。data state (interactive state ではない) に限る |
| subtle bg "chip" / banner / row                                 | ❌ 使うな      | `bg-<intent>-subtle` (step 3 solid) を使う                                                                                                                                           |
| disabled / de-emphasized text                                   | ❌ 使うな      | `text-foreground-muted` (gray-9 solid) を使う (Primer "NEVER" 規律)                                                                                                                  |
| interactive state (hover / active / selected)                   | ❌ 使うな      | `bg-element-hover` / `bg-element-active` / `bg-<intent>-subtle` を使う                                                                                                               |
| border / divider                                                | ❌ 使うな      | `border-border-subtle` (step 6 solid) で統一 (SSOT 純度優先)                                                                                                                         |
| 複雑な前景の上に半透明 layer を重ねる                           | ❌ 絶対禁止    | 下のレイヤーが透ける ([Improta 3 大禁忌](https://designtokens.substack.com/p/transparency-in-color-tokens))                                                                          |

`bg-<intent>/N` (`bg-destructive/15` 等) の opacity modifier 利用は **すべて anti-pattern**。「色を弱める」目的なら **必ず solid な低 step token** (`<intent>-subtle` / `foreground-muted` / `border-subtle`) を使う。

「コンテンツ全体の dim」例外は **interactive state ではなく data state** に限る (Improta 第 1 禁忌「interactive state を opacity で表現すると子要素まで伝播」を回避するため)。focus 外 pane や draft データのような「状態の dim 化」は許容、`hover:opacity-50` のような対話的 opacity 切り替えは禁止。

## Intent 選択の判定軸

| intent         | 意味                                   | 例                                                                                                    |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| primary        | 主要 action / 主要 active state        | submit button / mode tab indicator / current branch / active task row                                 |
| info           | 補助 active state / 中立的な情報リンク | sub-toggle (preview / wordwrap) / inline link / info badge (branch ref は lane 色 = `graphColors.ts`) |
| success        | 完了 / 成功                            | added file / untracked file / user message bubble                                                     |
| destructive    | 削除 / エラー / 危険                   | delete button / error toast / removed file                                                            |
| warning        | 進行中 / 一般的な注意                  | Claude `working` / `〜時間前` (recent stale) / modified file                                          |
| warning-strong | 要対応 / 強い注意                      | Claude `asking` / `〜日前` (older stale) / subagent badge                                             |

primary と info は同じ青系だが意味階層が異なる。同一 toolbar 内で「mode tab = primary、補助 toggle = info」のように要素の階層で分ける。「目立たせたいから primary」「ちょっと目立たせたいから info」のような曖昧基準は使わない。

**同一要素内で hover による intent 切り替えは禁止** (`text-info hover:text-primary` 等)。link の hover 強調は intent を変えず、`hover:underline` で表現する (`hover:opacity-N` は本 doc の Alpha 規律に反するので使わない)。

## Click handler は `<button type="button">`

click handler を持つ要素は必ず `<button type="button">`。`<div>` に `role="button"` + `tabindex="0"` + 手動 keydown handler の ARIA shim は禁止。`<button>` で書けば semantic / keyboard navigation / accessibility がすべて OS + browser の提供で自動成立する。form 内で使うときは `type="button"` を明示 (submit 暴発防止)。

## Keyboard navigation container は ARIA role を持つ

`<div tabindex="0">` + `@keydown` で矢印キー navigation する custom container は WAI-ARIA role 必須。role 無しは screen reader で widget 種別が判別できない silent semantic 違反。

| パターン                    | role                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| list 選択 navigation        | `role="listbox"` + 各 item `role="option"` + selected に `aria-selected="true"` |
| tree navigation             | `role="tree"` + 各 node `role="treeitem"`                                       |
| grid 2D navigation          | `role="grid"` + `role="row"` + `role="gridcell"`                                |
| 完全 custom (game / canvas) | `role="application"` (最後の手段)                                               |

複数選択 (range / multi) を許す listbox は `aria-multiselectable="true"` を追加。

## Focus 可能要素は focus ring 必須

`outline-none` 単独で UA outline を消すと silent focus (focus 中なのに視覚 indicator が消失) になり keyboard user は focus 位置が見えなくなる (accessibility 違反)。

- `<input>` / `<select>` / `<textarea>`: `focus:ring-2 focus:ring-ring focus:outline-none`
- `tabindex="0"` を持つ container: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset`

container は `focus-visible:` を使うと「キーボード focus のみ visual indicator を出し、マウスクリック後の focus は出さない」となり、頻繁に click される list row 等で persistent outline が消えて UX が綺麗。

## Inline style の SSOT 例外

`:style` を使ってよいのは以下のみ。それ以外の自前 UI 色 / 固定値 (`w-4` / `h-2` / `left-N` 等) を inline style で渡すのは禁止 (Tailwind utility を使う)。

**(a) 外部 theme 由来の動的色**: `@theme` で表現できない外部 system が返す hex (Shiki syntax highlight の `token.color` / iTerm2-Color-Schemes terminal theme の `currentTheme.background` 等)。

**(b) 動的計算値の layout / spacing**: reactive value (`sidebarWidth` / `playheadPct` / tree depth ベース `paddingLeft` / 分割 grid の `gridArea` 等)。Tailwind utility / arbitrary value では動的値を表現できない:

- position: `left` / `top` / `right` / `bottom` / `transform`
- size: `width` / `height` / `max-height` / `min-width` / `min-height`
- spacing: `gap` / `padding` / `padding-left` / `margin`
- grid: `grid-area` / `grid-template-rows` / `grid-template-columns`

**(c) 動的計算色 (内部生成)**: 次の 2 パターンを許容。

- **id / 名前 hash 由来**: 例: TerminalPane の `hashToColor` で repo 名 → HSL pastel 色。per-identifier 動的値で `@theme` に固定 token として持てない
- **有限固定 palette × variant 展開**: 例: `graphColors.ts` の 8 lane × 3 variant (text / remote-text / subtle-bg) を `laneTextColor()` / `laneRemoteTextColor()` / `laneSubtleBgColor()` で取得。Tier 2 alias に展開すると alias 表が肥大化 (24 token) するため、機能 module 内に helper を持って inline style 経由で渡す

## `class` は layout 専用

`class` は layout / spacing / sizing にだけ使う。色やタイポを上書きしない。色を変えるなら semantic token utility を当てるか、コンポーネント側に variant prop を生やす。

## `space-x-*` / `space-y-*` を使わない

`flex` + `gap-*` を使う。`space-y-4` は `flex flex-col gap-4`、`space-x-2` は `flex gap-2`。display 構造が変わるため canonical fix の対象外で、手動で書き換える。

## `dark:` を手書きしない

gozd は dark 固定。`dark:bg-X` のような手動上書きは禁止。token が light/dark を CSS variable 経由で内部解決する (将来 light theme 追加時は primitive を `.light` scope に再宣言)。

## 条件付き class は `:class` バインディングで書く

```vue
<!-- ✗ NG -->
<div :class="`flex items-center ${isActive ? 'bg-element-hover' : 'bg-panel'}`"></div>

<!-- ◯ OK -->
<div class="flex items-center" :class="isActive ? 'bg-element-active' : 'bg-panel'"></div>
```

固定 class は `class`、可変 class は `:class` に分離。両方混ぜると Vue が自動 merge する。

## overlay 要素に手動 `z-index` を付けない

`<dialog>` (native) は top layer に乗るので z-index 不要。Popover / Tooltip / 自前 overlay は stacking context を意識して構造を決める。`z-50` / `z-[999]` 等の数値直書きは緊急避難で、`absolute` / `fixed` の親子関係を見直す方が先。

## AI 出力 self-check (commit / PR 前、判断系のみ)

静的チェック対象 (生 palette / primitive 直参照 / 未定義 class / class 正規化) は lint / formatter が捕まえるので、ここでは判断が要る項目だけ確認:

- 選んだ token が「Intent 選択の判定軸」と整合しているか
- intent と用法の組み合わせが Tier 2 alias 内に収まっているか (新規 alias が要るなら main.css に追加してから使う)
- click handler を持つ要素が `<button type="button">` で書かれているか
- 矢印キー navigation の container に WAI-ARIA role が付いているか
- focus を受け取る要素に focus ring 表現があるか
- 固定値の inline style (`:style="{ marginTop: '2px' }"` 等) を使っていないか
- 新規 SFC に `<doc lang="md">` ブロックを書いたか (apps/renderer/CLAUDE.md 規約)
- 新規 SFC のテキストが英語か (apps/renderer/CLAUDE.md 規約)

## 参照

- Token SSOT: `apps/renderer/src/assets/main.css` の `:root` (Tier 1) + `@theme inline` (Tier 2)
- Primitive 生成 package: [`packages/design-tokens`](../../../packages/design-tokens) (Adobe Leonardo contrast-driven、prepare で自動 build)
- Lint plugin: `packages/eslint-plugin/src/rules/noRawTailwindPalette.ts`
- Renderer 全体規約: `apps/renderer/CLAUDE.md`
