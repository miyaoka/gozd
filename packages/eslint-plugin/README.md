# @gozd/eslint-plugin

gozd プロジェクト固有の ESLint ルールを提供する。

## ルール

### `gozd/no-define-expose`

Vue SFC の `defineExpose` の使用を禁止する。

親から子の内部メソッドを命令的に呼ぶ設計はコンポーネント間の依存を不透明にする。値は props で渡し、子が自分で処理する。共有ロジックは composable に出す。

#### 判定ロジック

`defineExpose` は Vue の compiler macro であり、import されずに直接呼び出される。AST 上は `CallExpression` で callee が Identifier `defineExpose` となる。識別子名一致のみで判定するため、`foo.defineExpose()` のような member call や別名で wrap した呼び出しは対象外。

#### 設定例

```typescript
import pluginGozd from "@gozd/eslint-plugin";

export default [
  {
    plugins: {
      gozd: pluginGozd,
    },
    rules: {
      "gozd/no-define-expose": "error",
    },
  },
];
```
