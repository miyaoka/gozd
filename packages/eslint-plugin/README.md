# @gozd/eslint-plugin

gozd 固有の規約を lint で強制する。**規約の意図はここに書き、判定の実装はルール側に閉じる。**

## ルール

| ルール                         | 禁止するもの                               | 理由                                                                                                |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `gozd/no-define-expose`        | Vue SFC で子の内部メソッドを外部へ公開する | 親から子を命令的に呼ぶ設計は依存を不透明にする。値は props で渡し、共有ロジックは composable に出す |
| `gozd/no-iconify-class`        | class 名によるアイコン指定                 | アイコンは明示 import で書き、存在しない名前をビルドエラーにする。class 名では検出できない          |
| `gozd/no-raw-tailwind-palette` | 生のカラーパレットと primitive の直参照    | 色は semantic token だけを使う（テーマ切替が効かなくなるため）                                      |

## 使い方

```typescript
import pluginGozd from "@gozd/eslint-plugin";

export default [
  {
    plugins: { gozd: pluginGozd },
    rules: {
      "gozd/no-define-expose": "error",
      "gozd/no-iconify-class": "error",
      "gozd/no-raw-tailwind-palette": "error",
    },
  },
];
```
