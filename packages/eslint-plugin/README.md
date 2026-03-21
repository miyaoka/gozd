# @gozd/eslint-plugin

`features/` と `shared/` のバレルファイル（index.ts）強制と依存方向制御を行う ESLint プラグイン。

## ルール

### `gozd/barrel-import`

`features/` や `shared/` 配下のモジュールはバレルファイル（index.ts）経由でのみ import 可能にする。設定不要。

#### 判定ロジック

import パスを解決し、`features/X/` や `shared/X/` のスコープを抽出して以下を判定する。

- **スコープ外 → スコープ内**: index.ts 経由のみ許可。内部ファイルの直接 import は禁止
- **同一スコープ内**: 自由に import 可能
- **子 feature → 親スコープ**: 自由に import 可能（子は親の一部）
- **子 feature 間**: index.ts 経由のみ許可。異なる子 feature の内部ファイル直接 import は禁止
- **shared → features**: 全面禁止（バレル経由でも不可。下位層が上位層に依存してはいけない）

#### 対応パターン

```text
NG: feature 外 → 内部モジュール直接 import
NG: 親 feature 内 → 子 feature の内部モジュール直接 import（再帰的にネストされた子 feature 含む）
NG: 親 feature 内 → 子 feature のバレルでないファイル直接 import
NG: 子 feature 間の内部直接 import
NG: shared → feature（バレル経由でも禁止）
OK: feature 外 → バレル経由
OK: 親 feature 内 → 子 feature のバレル経由
OK: 親 feature 内 → 再帰的にネストされた子 feature のバレル経由
OK: 同一 feature / shared 内の通常ファイル参照
OK: 子 feature → 親の通常ファイル参照
OK: 子 feature 間のバレル経由
OK: 外部パッケージ（相対パスでない import）
```

#### スコープの抽出

パス内の `features/X` または `shared/X` を最も深い位置から探し、スコープとする。

```text
src/features/terminal/useTerminalStore.ts         → features/terminal
src/features/sidebar/features/worktree/index.ts   → features/worktree
src/shared/rpc/useRpc.ts                          → shared/rpc
```

## 設定例

```typescript
import pluginGozd from "@gozd/eslint-plugin";

export default [
  {
    plugins: {
      gozd: pluginGozd,
    },
    rules: {
      "gozd/barrel-import": "error",
    },
  },
];
```
