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

#### Intent 選択の判定軸 (意味別の使い分け)

intent を 1 つ選ぶときは以下の意味マップに従う。同一 UI で primary / info / success が
乱立しないよう、active 状態は **要素の階層** (主要 vs 補助) で intent を分ける:

| intent         | 意味                                   | 例                                                                                                              |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| primary        | 主要 action / 主要 active state        | submit button / mode tab indicator / current branch / active task row                                           |
| info           | 補助 active state / 中立的な情報リンク | sub-toggle (preview / wordwrap) / inline link / info badge / ref / branch / 識別子 text / renamed / copied file |
| success        | 完了 / 成功 / 整合状態                 | added file / untracked file / synced ref / user message bubble                                                  |
| destructive    | 削除 / エラー / 危険                   | delete button / error toast / removed file                                                                      |
| warning        | 進行中 / 一般的な注意                  | Claude `working` state / `〜時間前` (recent stale) / modified file                                              |
| warning-strong | 要対応 / 強い注意                      | Claude `asking` state / `〜日前` (older stale) / subagent badge                                                 |

primary と info は同じ青系だが意味階層が異なる。同一 toolbar 内で「mode tab = primary、
補助 toggle = info」のように要素の階層で分ける。「目立たせたいから primary」「ちょっと
目立たせたいから info」のような曖昧基準は使わない。

**同一要素内で hover による intent 切り替えは禁止**。`text-info hover:text-primary` のような
hover で intent 階層が動的に変わる pattern は、SKILL の階層分け規律 (要素の階層 = 静的)
と矛盾する。link の hover 強調は intent を変えず、`hover:underline` / `hover:opacity-80` 等
の装飾で表現する。

#### Intent ペア (primary / destructive / success / warning / warning-strong / info)

intent (`primary` / `destructive` / `success` / `warning` / `warning-strong` / `info`)
を当てるときは **必ず以下の用法表のどれか** で書く。`bg-<intent>` と `text-<intent>` を
**同 token で直接 pair しない** (両方とも palette 由来の同色になり contrast を割る)。
alpha 値は表に書かれた値からのみ選ぶ (詳細は下節 「opacity 修飾子は固定セットから選ぶ」)。
表外の値 (bg `/20` / `/25` / `/50` 等) は SSOT 違反として禁止。

| 用法                                                           | bg                                    | border               | text                       |
| -------------------------------------------------------------- | ------------------------------------- | -------------------- | -------------------------- |
| **solid button** (click 可能、hover あり)                      | `bg-<intent>`                         | —                    | `text-<intent>-foreground` |
| **solid static** (current branch / static badge / toggle chip) | `bg-<intent>`                         | —                    | `text-<intent>-foreground` |
| **translucent solid** (chat bubble)                            | `bg-<intent>/40`                      | —                    | `text-<intent>-foreground` |
| **bordered translucent** (強調塗りコンテナ / 選択強調)         | `bg-<intent>/40`                      | `border-<intent>/60` | `text-<intent>-foreground` |
| **outlined banner** (toast / banner)                           | `bg-<intent>/15`                      | `border-<intent>/60` | neutral (継承)             |
| **subtle chip** (badge / tag / inline alert)                   | `bg-<intent>/15`                      | —                    | `text-<intent>`            |
| **faint chip** (file status row / icon chip)                   | `bg-<intent>/10`                      | —                    | `text-<intent>`            |
| **line tint** (diff 行 / 弱い背景強調)                         | `bg-<intent>/10`                      | —                    | neutral (継承)             |
| **selected row** (active list item)                            | `bg-<intent>/30 hover:bg-<intent>/40` | —                    | neutral (継承)             |
| **indicator stripe** (active tab 下線 / underline)             | —                                     | `border-<intent>`    | `text-<intent>`            |
| **text-only** (link / icon / inline)                           | —                                     | —                    | `text-<intent>`            |

text 列の **neutral (継承)** は「intent text を当てない (中身が `text-foreground` 系の通常
コンテンツを wrap する container)」。明示するなら `text-foreground` / `text-foreground-strong`
/ `text-foreground-muted` 等の neutral 系を当てる、しないなら親要素から継承させる。

`solid button` と `solid static` は bg / text 列が同値だが hover 列の有無で別用法。click
可能で hover フィードバックが要る要素は `solid button`、static badge / 状態 toggle で
hover による視覚変化が無い要素は `solid static` (hover 表に項目を持たない)。

text 列が `text-<intent>` / `text-<intent>-foreground` の用法は **その要素が intent を
text として運ぶ** (chip / button / chat bubble)。text 列が `neutral (継承)` の用法は
**container** で、中身は通常コンテンツ (`text-foreground` 系) を wrap し、intent は chrome
(bg / border / icon) で示す。

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
| solid button      | `bg-<intent>`    | `hover:bg-<intent>/80` |
| translucent solid | `bg-<intent>/40` | `hover:bg-<intent>/80` |
| selected row      | `bg-<intent>/30` | `hover:bg-<intent>/40` |
| subtle chip       | `bg-<intent>/15` | `hover:bg-<intent>/30` |
| faint chip        | `bg-<intent>/10` | `hover:bg-<intent>/15` |

hover 値は **上の hover 表に書かれた値だけ** を使う。`hover:bg-<intent>/80` を base alpha
が小さい chip 系で使うと 5 倍以上の濃度跳躍になり視覚過剰、`/45` / `/35` のような中間値も
SSOT 違反。表に含まれない用法 (`solid static` / `bordered translucent` / `outlined banner` /
`line tint` / `indicator stripe` / `text-only`) は **hover 効果なし** (規律上 hover を付けない)。

同じ alpha 値 (`/30` / `/40`) が複数行 (subtle chip の hover bg と selected row の base bg、
selected row の hover bg と translucent solid の base bg) に出現するが、これは許容: alpha
だけで用法判定はせず、要素種別 (chip / row / button) × 状態軸 (base / hover) の組で意味判定
する。chip と list row は空間的に重ならないため視覚的衝突は起きない。

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

- base bg / border: 用法表に従う
- hover bg: hover 表に従う

表外の値 (例: bg `/20` / `/25` / `/50`) は SSOT 違反として禁止。表が値の SSOT で、本文の
列挙は表が変わるたびにずれるため意図的に避ける。text 側の強度減衰 (`text-success/70` 等) は
連続値で OK (情報の主役は色相 + 強度減衰)。raw 色との組み合わせ (`bg-red-500/20` 等) は禁止
(intent token を使う)。

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
