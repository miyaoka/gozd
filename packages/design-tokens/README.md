# @gozd/design-tokens

Tier 1（primitives）の design token を **contrast 駆動のアルゴリズムで生成**する。出力は
CSS 変数。

## tier の分離

| Tier                      | 責任                          | 配置               |
| ------------------------- | ----------------------------- | ------------------ |
| Tier 1 (primitives)       | 物理的な色値、12 段のスケール | この package       |
| Tier 2 (semantic aliases) | role 名 → primitive の写像    | 利用側の entry CSS |
| Tier 3 (element defaults) | UA スタイルシートの上書き     | 利用側の entry CSS |

**この package は role を知らない。** 「どの step をどの用途に使うか」は利用側の責務。

## 利用側への要求

公開するのは `@gozd/design-tokens/tokens.css` の 1 つだけ。中身は CSS 変数で、role 名は持たない。
利用側はこれを読み込んだうえで **semantic alias（role 名 → primitive の写像）を自分で定義する**。

## token 一覧

| 名前             | 種別  | intent                     |
| ---------------- | ----- | -------------------------- |
| `--gray-1..12`   | solid | 中立（bg / border / text） |
| `--gray-a1..a12` | alpha | overlay / chrome           |
| `--blue-1..12`   | solid | primary / info             |
| `--red-1..12`    | solid | destructive                |
| `--green-1..12`  | solid | success                    |
| `--amber-1..12`  | solid | warning                    |
| `--orange-1..12` | solid | warning-strong             |

step → 用途の写像は Radix の規約に従う。

| step | 用途                                        |
| ---- | ------------------------------------------- |
| 1-2  | app / subtle な背景                         |
| 3-5  | コンポーネント背景（通常 / hover / active） |
| 6    | 非対話の境界線                              |
| 7    | 対話可能な境界線                            |
| 8    | 強い境界線 / フォーカスリング               |
| 9-10 | 塗りつぶし背景（通常 / hover）              |
| 11   | 低コントラストのテキスト                    |
| 12   | 高コントラストのテキスト                    |

**step 11 / 12 は目標コントラスト比を満たすことが生成時に保証される。**

## なぜ生成するか

contrast 駆動の生成器は **目標コントラストを入力に指定すると、それを満たす色を逆算する**。
テキスト用の step が要求水準を確実に満たす。

**手書きすると、色域上の彩度限界とコントラスト検証が手動になり破綻しやすい。**

## brand の変更

**primitives は手書きしない。** brand の変更は生成器への入力を変えることで行い、出力は必ず再生成
された結果とする。

> [!NOTE]
> テーマに追従しない固定の brand 色（外部サービスの指定配色など）は生成パイプラインに乗らないため、
> 利用側で例外として手書きし、命名規約で識別できるようにする。
