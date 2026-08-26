---
name: test
description: テストを書く / 直すときの runner の選び分け。既定は bun test、実ブラウザでしか判定できないものだけ vitest browser mode。
---

# test — runner の選び分け

gozd のテストは 2 つの runner に分かれる。**どちらに書くかは「検証対象が何を必要とするか」で決まり**、ファイルの置き場所や対象が SFC かどうかでは決まらない。

| runner              | ファイル名          | 実行環境                 | 実行                                            |
| ------------------- | ------------------- | ------------------------ | ----------------------------------------------- |
| bun test            | `*.test.ts`         | Node 相当。DOM なし      | `pnpm --filter <pkg> run test`                  |
| vitest browser mode | `*.browser-test.ts` | 実 Chromium (Playwright) | `pnpm --filter @gozd/renderer run test:browser` |

集約は root の `pnpm run test:all` / `pnpm run test:browser:all`（CI の matrix と同一）。browser mode は Chromium headless shell を要する。未取得のとき、および playwright を更新したときに `pnpm --filter @gozd/renderer run test:browser:setup` を実行する（browser の revision は playwright の版に紐づく）。

## 判断

**既定は bun test。** browser mode は「実ブラウザでしか判定できない」と言える理由があるときだけ選ぶ。

**Vue 配線（watch・lifecycle・store 結線）そのものはテスト対象にしない。**

### bun test に書く

- 純関数・データ変換・パス計算・状態遷移の規則
- store のロジック（描画を見ないもの）
- **Vue SFC に書かれたロジックも、切り出せるなら `.ts` の純関数にして bun へ寄せる。** 判定・整形・分岐の規則はテンプレートやライフサイクルを必要としない。SFC のままテストする理由が「そこに書いてあるから」なら、それは切り出しの合図

### browser mode に書く

実ブラウザの持ち物を判定に使うときだけ。

- **当たり判定**: 押した座標に要素が居るか、他要素に覆われていないか
- **レイアウト**: 実寸の矩形、はみ出し、スクロール、要素同士の重なり
- **可視性**: 見えているか、クリックできる状態か
- **実 CSS**: Tailwind の解決結果、design token、`:hover` / `:active` などの状態スタイル
- ブラウザ API そのもの（Popover、anchor positioning、`elementFromPoint` 等）

## DOM シミュレーション環境を足さない

jsdom / happy-dom は導入しない。レイアウトを持たず、イベントも `dispatchEvent` で流し込むだけなので、上の 5 項目をどれも判定できない。「押せない要素を押せたことにする」偽陽性を作る。Vitest 自身が browser mode を作った理由としてこの限界を明記している。

同じ理由で `@vue/test-utils` の `trigger()` を直接使わない。座標も重なりも見ないため、実ブラウザで押せない要素でもテストは通る。browser mode では locator 経由で操作する（Playwright の actionability check が当たり判定の SSOT になる）。

## ファイル名が runner の境界

bun は `*.test.*` / `*.spec.*` / `*_test.*` / `*_spec.*` を拾う。browser mode 側を `*.browser-test.ts` にしているのは、このパターンに**一致しないから**。除外フラグで住み分けると、命名を外れたファイルが両方の runner で走る。

## browser mode の落とし穴

### 器の寸法がテスト条件になる

`render(Component, { container })` に実運用の寸法の div を渡し、その div は `document.body` 直下に挿す。挿さないと矩形が全て 0 になり locator が not visible で timeout する。body 直下でないと `cleanup()` が container を外さず、次のテストのレイアウトに残る。当たり判定の不具合は要素の寸法が入力なので、狭い器では症状が消える（幅いっぱいの行の押下変位が幅に比例していた不具合は、240px では再現せず 630px で再現した）。

### Playwright の click は押下前にスクロールと安定待ちをする

そのため「押下をきっかけに対象が動く」レースは吸収されて再現しないことがある。

座標を固定した生の入力が要るなら `import { cdp } from "vitest/browser"`（公式 API。playwright provider + chromium 限定）。API サーバを非 localhost の host へ公開した構成では `browser.api.allowWrite` / `browser.api.allowExec` が既定で落ち、CDP も使えなくなる。**テストは iframe 内で走る**（`window.frameElement` が `IFRAME`）ため、CDP に渡す座標は top-level のもので、テスト内の `getBoundingClientRect()` とは原点が違う。

### 要素は role / label で取る。座標指定は当たり判定を見るときだけ

既定は `getByRole` / `getByLabelText` 等の locator で取って `click()` する（`vitest-browser-vue` は testing-library の原則に沿い、操作 API を locator に限っている）。生 DOM (`container` 等) を掴むのは、role / label を持たない要素の計算値や矩形を見るときだけ。

`click({ position })` でピクセルを指定するのは、**その要素のどこが効かないか自体が検証対象**のときに限る。通常の操作で座標を書くと、レイアウトを変えるたびに意味を失って壊れる。

### 失敗時の証跡が残る

DOM ダンプがコンソールに出て、スクリーンショットが `__screenshots__` に、添付が `.vitest-attachments` に残る（どちらも gitignore 済み）。原因を推測する前にこれを見る。

### 重い依存を足した直後は dep 最適化のリロードで落ちる

`Vite unexpectedly reloaded a test` で全ファイルが import エラーになる。警告が名指しした依存を `vite.config.ts` の `optimizeDeps.include` に足す。再実行すれば通るが、それは最適化が済んだだけで、cold cache の CI では再発する。

## テスト実行は無出力が正常

console 出力や framework 警告が漏れるのは、テスト対象の設計かテストの書き方の欠陥であり、「観察ログなので許容」で放置しない。

- テストが踏む経路に観察ログ（`console.*`）があるなら spy で吸う。ログがその経路の契約なら、黙らせるだけでなく発火内容まで assert に昇格する
- spy が効かないときはテスト側で妥協せず実装側の束縛を疑う。module load 時に console の関数参照を掴むと spy のプロパティ差し替えが届かない。呼び出し時に `console[method]` を引く形に直す

## 依存とセットアップの所在

`vitest` / `@vitest/browser-playwright` / `playwright` / `vitest-browser-vue` は `apps/renderer` の devDependency。設定はアプリの `vite.config.ts` に `test` として同居させる。plugin 構成（SFC コンパイル / Tailwind / icon の virtual module）がアプリと 1 つでも違えば、テストが検証しているのはアプリではなくなるため、設定ファイルを分けて片方だけ育つ余地を作らない。

`vitest.setup.ts` が `main.css` を読み込む。レイアウトと状態スタイルを判定する構成なので、Tailwind utility と design token が効いていない DOM を相手にしても意味を持たない。
