# @gozd/design-tokens

Tier 1（primitives）の design token を **contrast 駆動のアルゴリズムで生成**する。出力は
CSS 変数。

## 責務

- **生成 scale**: 無彩色（solid + alpha）と intent hues の 12-step scale。step はコントラスト
  比の昇順に並び、テキスト用の高 step は目標コントラスト比を満たすことが生成時に保証される
- **検証済み設計値**: scale 内の知覚不変条件（全ペア ΔE）を要する固定値（age scale）。
  値と検証はこの package が持ち、違反は生成失敗 = ビルド失敗になる

token は `src/generateTokens.ts` から `dist/tokens.generated.css` に生成される。

## tier の分離

| Tier                      | 責任                       | 配置               |
| ------------------------- | -------------------------- | ------------------ |
| Tier 1 (primitives)       | 物理的な色値               | この package       |
| Tier 2 (semantic aliases) | role 名 → primitive の写像 | 利用側の entry CSS |
| Tier 3 (element defaults) | UA スタイルシートの上書き  | 利用側の entry CSS |

**この package は semantic alias（Tier 2）を持たない。** step をどの用途に使うかの語彙は
利用側（gozd-ui skill）が持つ。

## 利用側への要求

- 公開するのは `@gozd/design-tokens/tokens.css` の 1 つだけ。利用側はこれを読み込み、
  semantic alias を自分で定義する
- **primitives は手書きしない。** brand の変更は生成器への入力（`BRAND`）を変えて再生成する。
  手書きすると、色域上の彩度限界とコントラスト検証が手動になり破綻しやすい

> [!NOTE]
> 固定値の置き場は知覚検証の有無で分かれる。生成値との知覚不変条件を検証する必要がある設計値
> （age scale）はこの package の生成器が持つ。検証を伴わない、テーマに追従しない固定 brand 色
> （外部サービスの指定配色など）は利用側で例外として手書きし、命名規約
> `--<scope>-<role>-primitive` で識別できるようにする。
