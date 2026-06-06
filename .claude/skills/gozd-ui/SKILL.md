---
name: gozd-ui
description: gozd の renderer (Vue + Tailwind v4) で UI を書く / 直すときの規律。semantic token しか使わせない (生 zinc / blue / red 等は禁止)、shadcn 由来の Critical Rules を Vue 文脈に翻訳した一式。Vue SFC / Tailwind class / `apps/renderer/src/assets/main.css` の token を触る作業すべてに自動適用される。
---

# gozd-ui — Vue + Tailwind v4 design rules

renderer (`apps/renderer`) の UI を書く / 直すときは必ずこの規律に従う。違反は AI slop の主要源として `design-reviewer` (`.claude/agents/`) が指摘する。

## 1. Semantic token 以外の色を使わない

色は **必ず token 名で書く**。生 Tailwind palette (`zinc` / `blue` / `red` / `white` / `black` / `gray` / `slate` / ...) は `apps/renderer` 配下では禁止。`hover:` / `dark:` / opacity 修飾子 (`/40` 等) も含めて 1 つも残さない。

Token 一覧は SSOT として `apps/renderer/src/assets/main.css` の `@theme` ブロックを参照する。不足したら **raw に逃げず main.css に variable を増やす**。

### 用途別 token (intent-based)

#### Surface / Foreground / Border (intent なし、用途別)

| 用途                                 | Token (Tailwind utility) |
| ------------------------------------ | ------------------------ |
| ページ背景                           | `bg-background`          |
| カード / panel                       | `bg-surface-1`           |
| 持ち上がった panel / chip / hover 塗 | `bg-surface-2`           |
| 本文                                 | `text-foreground`        |
| 強調 / heading                       | `text-foreground-strong` |
| secondary text                       | `text-foreground-muted`  |
| placeholder / tertiary               | `text-foreground-subtle` |
| 既定の 1px 区切り                    | `border-border`          |
| 強調 outline                         | `border-border-strong`   |
| 同色面の弱い divider                 | `border-divider`         |
| 階層境界を明示する厚め divider       | `border-divider-strong`  |
| hover 背景                           | `hover:bg-accent`        |
| selected / pressed 背景              | `bg-accent-strong`       |
| focus ring                           | `ring-ring`              |
| dialog backdrop                      | `bg-overlay`             |

#### Intent vs Accent の使い分け

要素が **特定 intent を意味する** (active 状態が primary を表す / エラーが destructive
を表す 等) なら intent system を使う。intent を持たない **汎用 hover / selection
overlay** (一覧の generic item / menu hover) は accent system (`bg-accent` /
`bg-accent-strong`) を使う。「active な list item」でも「primary という意味を持つ active」
なら intent 系 selected row、「単に選択された汎用 item」なら `bg-accent-strong`。

#### Intent ペア (primary / destructive / success / warning / warning-strong / info)

intent (`primary` / `destructive` / `success` / `warning` / `warning-strong` / `info`)
を当てるときは **必ず以下 9 つの用法のどれか** で書く。`bg-<intent>` と `text-<intent>` を
**同 token で直接 pair しない** (両方とも palette 由来の同色になり contrast を割る)。
alpha 値は以下の **固定セット** (bg = `/10` / `/15` / `/30` / `/40`、border = `/60`)
からのみ選ぶ。他 (`/20` / `/25` / `/50` 等) は SSOT 違反として禁止。

| 用法                                                   | bg                                    | border               | text                       |
| ------------------------------------------------------ | ------------------------------------- | -------------------- | -------------------------- |
| **solid** (button)                                     | `bg-<intent>`                         | —                    | `text-<intent>-foreground` |
| **translucent solid** (chat bubble)                    | `bg-<intent>/40`                      | —                    | `text-<intent>-foreground` |
| **bordered translucent** (強調塗りコンテナ / 選択強調) | `bg-<intent>/40`                      | `border-<intent>/60` | `text-<intent>-foreground` |
| **outlined banner** (toast / banner; 中身は neutral)   | `bg-<intent>/15`                      | `border-<intent>/60` | —                          |
| **subtle chip** (badge / tag / inline alert)           | `bg-<intent>/15`                      | —                    | `text-<intent>`            |
| **faint chip** (file status row / icon chip)           | `bg-<intent>/10`                      | —                    | `text-<intent>`            |
| **line tint** (diff 行 / 弱い背景強調; 中身は neutral) | `bg-<intent>/10`                      | —                    | —                          |
| **selected row** (active list item; 中身は neutral)    | `bg-<intent>/30 hover:bg-<intent>/40` | —                    | —                          |
| **indicator stripe** (active tab 下線 / underline)     | —                                     | `border-<intent>`    | `text-<intent>`            |
| **text-only** (link / icon / inline)                   | —                                     | —                    | `text-<intent>`            |

text 列が `text-<intent>` / `text-<intent>-foreground` の用法は **その要素が intent を
text として運ぶ** (chip / button / chat bubble)。text 列が `—` の用法は **container** で、
中身は通常コンテンツ (`text-foreground` 系) を wrap し、intent は chrome (bg / border /
icon) で示す。

`<intent>-foreground` を持つのは `primary` / `destructive` / `success` / `warning` /
`warning-strong`。`info` のみ未定義のため solid / translucent solid / bordered translucent
で使えない (text-only / chip 系 / line tint / selected row / indicator stripe のみ可)。
warning / warning-strong は light yellow / mid-light orange (OKLCH 0.852 / 0.75) なので
foreground は dark zinc で contrast を成立させる。他 intent (primary / destructive /
success) は中間明度で light foreground (white-ish)。

hover state は **必ず base と異なる token / alpha** を当てる (`hover:bg-warning-strong`
のように base と同 token は dead branch)。hover 用 alpha も **固定値** で運用する:

| base 用法         | base bg          | hover bg               |
| ----------------- | ---------------- | ---------------------- |
| solid             | `bg-<intent>`    | `hover:bg-<intent>/80` |
| translucent solid | `bg-<intent>/40` | `hover:bg-<intent>/80` |
| selected row      | `bg-<intent>/30` | `hover:bg-<intent>/40` |
| subtle chip       | `bg-<intent>/15` | `hover:bg-<intent>/30` |
| faint chip        | `bg-<intent>/10` | `hover:bg-<intent>/15` |

hover 値は base alpha の **1 段階上** が原則 (base alpha 固定セット `/10` → `/15` → `/30` →
`/40` の 1 段移動)。`solid` / `translucent solid` のみ alpha なし base から `/80` 透過に
切り替える例外。`hover:bg-<intent>/80` を base alpha が小さい chip 系で使うと 5 倍以上の
濃度跳躍になり視覚過剰のため禁止。

### ✗ NG

```html
<div class="bg-zinc-900 text-zinc-400 hover:bg-zinc-800">…</div>
<span class="text-blue-400">…</span>
<button class="bg-red-500 text-white">Delete</button>
```

### ◯ OK

```html
<div class="bg-background text-foreground-muted hover:bg-accent">…</div>
<span class="text-info">…</span>
<button class="bg-destructive text-destructive-foreground">Delete</button>
```

### orange と yellow を `text-warning` にまとめない

`text-warning` (yellow) は「進行中 / 軽い注意」、`text-warning-strong` (orange) は「要対応」。Claude state の `working` (warning) と `asking` (warning-strong)、relative date の `〜時間前` (warning) と `〜日前` (warning-strong) のように、強度の差が意味を持つ場面では区別を維持する。

### opacity 修飾子は固定セットから選ぶ

intent の alpha 値は **上記表の各行に書かれた値からのみ** 選ぶ:

- base bg: `/10` / `/15` / `/30` / `/40` / 無し (用法表に従う)
- hover bg: `/40` / `/80` (上の hover 表に従う)
- border: `/60` / 無し (用法表に従う)

表外の値 (bg `/20` / `/25` / `/50`、border `/40` / `/20` 等) は SSOT 違反として禁止。text
側の強度減衰 (`text-success/70` 等) は連続値で OK (情報の主役は色相 + 強度減衰)。raw 色との
組み合わせ (`bg-red-500/20` 等) は禁止 (intent token を使う)。

### Input element の focus 表現は `focus:ring-ring`

`<input>` / `<select>` / `<textarea>` の focus は border ではなく **ring (`focus:ring-2
focus:ring-ring`)** で示す。`focus:border-<intent>` (alpha なしの solid border) は
border alpha SSOT 違反 + indicator stripe 用法と紛らわしいため禁止。`focus:outline-none`
で UA outline を消し、ring で active state を出す。

## 2. `class` は layout 専用

`class` (`className` in shadcn) は **layout / spacing / sizing** にだけ使う。色やタイポを上書きしない。

| やりたいこと | 手段                                                   |
| ------------ | ------------------------------------------------------ |
| 色を変える   | semantic token utility を当てる、もしくは variant prop |
| variant      | コンポーネント側に `variant` prop を生やして switch    |
| 強調         | `text-foreground-strong` 等の意味的 token              |

### ✗ NG

```html
<Card class="bg-blue-100 font-bold text-blue-900">Dashboard</Card>
```

### ◯ OK

```html
<Card class="mx-auto max-w-md">Dashboard</Card>
```

カスタムが必要なら component 側で対応する (props / variant / @theme への token 追加)。`class` で局所的に色を上書きするのは AI slop の典型。

## 3. `space-x-*` / `space-y-*` を使わない

`flex` + `gap-*` を使う。`space-y-4` は `flex flex-col gap-4`。`space-x-2` は `flex gap-2`。

### ✗ NG

```html
<div class="space-y-4"><input /><button /></div>
```

### ◯ OK

```html
<div class="flex flex-col gap-4"><input /><button /></div>
```

## 4. `size-*` を `w-* h-*` より優先

幅と高さが等しいときは `size-*` を使う。icon / avatar / skeleton / 正方形ボタン全部。

```html
<span class="icon-[lucide--x] size-4" /> ✓ <span class="icon-[lucide--x] h-4 w-4" /> ✗
```

## 5. `truncate` 短縮形を使う

`overflow-hidden text-ellipsis whitespace-nowrap` を 1 行で書かず `truncate` を使う。

## 6. `dark:` を手書きしない

gozd は dark 固定。`dark:bg-X` のような手動上書きは禁止。token が light/dark を CSS variable 経由で内部解決する。

```html
<div class="bg-background">…</div>
✓
<div class="bg-white dark:bg-zinc-900">…</div>
✗
```

## 7. 条件付き class は `:class` バインディングで書く

Vue は `:class` で配列 / オブジェクトを受ける。テンプレートリテラル ternary を `class` に文字列結合するのは禁止 (shadcn の `cn()` 規律と同根)。

### ✗ NG

```html
<div :class="`flex items-center ${isActive ? 'bg-accent' : 'bg-surface-1'}`"></div>
```

### ◯ OK

```html
<div class="flex items-center" :class="isActive ? 'bg-accent-strong' : 'bg-surface-1'"></div>
```

固定 class は `class`、可変 class は `:class` に分離する。両方混ぜると Vue が自動 merge する。

## 8. overlay 要素に手動 `z-index` を付けない

`<dialog>` (native) は top layer に乗るので z-index 不要。Popover / Tooltip / 自前の overlay は stacking context を意識して構造を決める。`z-50` / `z-[999]` 等の数値直書きは緊急避難で、`absolute` / `fixed` の親子関係を見直す方が先。

## 9. テンプレートで複雑なことをしない

`v-for` 内で関数呼び出しを複数行に分けたり、`:class` で computed を 3 つ組み合わせたら、その時点でコンポーネント分割のサインです (apps/renderer/CLAUDE.md `## コンポーネント分割` 規約)。分離先で `computed` に閉じ込め、テンプレートは単純参照に倒す。

## 10. AI 出力 self-check (commit / PR 前)

UI 変更を含む diff を出す前に、自分でこの check を回す。引っかかったら直してからユーザーに見せる。

- 生 palette (`zinc-` / `blue-` / `red-` / `white` / `black` / `gray-` / `slate-` 等) が 1 つも残っていないか
- `class` に色 utility が混ざっていないか (色は token utility 経由 or variant prop)
- `space-y-*` / `space-x-*` を新規追加していないか
- `w-N h-N` (N 同値) を `size-N` に直したか
- `dark:` 手動上書きを足していないか
- 条件 class が template literal ternary になっていないか
- 新規 SFC に `<doc lang="md">` ブロックを書いたか (apps/renderer/CLAUDE.md 規約)
- 新規 SFC のテキストが英語か (apps/renderer/CLAUDE.md 規約)

self-check で迷ったら `design-reviewer` subagent を `claude-design-review` skill 経由で呼ぶ。

## 参照

- Token SSOT: `apps/renderer/src/assets/main.css` の `@theme` ブロック
- Renderer 全体規約: `apps/renderer/CLAUDE.md`
- 元になった shadcn rules: `~/ghq/github.com/shadcn-ui/ui/skills/shadcn/rules/`
