# LSP（型診断）

プロジェクト内の TypeScript / Vue ファイルの型エラー・警告をリアルタイムに検出し、DiagnosticsPane に表示する。

## アーキテクチャ

```
orkis (desktop)
  ├── tsgo LSP
  │     対象: TS/JS ファイル（apps/renderer 以外）
  │     方式: pull diagnostics (textDocument/diagnostic, LSP 3.17)
  │
  └── vue-language-server + tsserver bridge
        対象: apps/renderer 配下の TS/JS/Vue ファイル
        方式: tsserver の semanticDiagnosticsSync で直接取得
        ↕ tsserver/request, tsserver/response (カスタム LSP 通知)
        tsserver + @vue/typescript-plugin
```

## 診断の取得方式

### tsgo（TS/JS）

- `tsgo --lsp --stdio` で起動
- LSP 3.17 の pull diagnostics（`textDocument/diagnostic`）でファイル単位に診断を取得
- モノレポルートを `rootDir` とし、各パッケージの tsconfig.json を自動検出
- `requiredBin: "tsgo"` で `node_modules/.bin/tsgo` が無いパッケージはスキップ

### Vue

- Vue の型診断は Vue Language Server の `publishDiagnostics` ではなく、tsserver 内の `@vue/typescript-plugin` が生成する（VS Code と同じ仕組み）
- orkis では tsserver に `semanticDiagnosticsSync` コマンドを直接送って診断を取得
- Vue Language Server は tsserver bridge としてのみ使用（`publishDiagnostics` は無視する）

## tsserver bridge

Vue Language Server は `tsserver/request` / `tsserver/response` カスタム LSP 通知で tsserver に問い合わせる設計。VS Code 外ではこの bridge を自前実装する必要がある。

```
Vue Language Server
  → tsserver/request 通知 (JSON-RPC params: [[id, command, args]])
    → orkis が受け取り、tsserver の stdin にフォワード
      → tsserver のレスポンスを stdout から読み取り
        → tsserver/response 通知 ([[id, body]]) として Vue Language Server に返す
```

> [!NOTE]
> vscode-languageserver の `sendNotification` は params を rest パラメータとして spread するため、JSON-RPC 上では `[[id, command, args]]` のように外側の配列が1段追加される

### tsserver の初期化

- `--globalPlugins @vue/typescript-plugin` でプラグインをロード
- `--pluginProbeLocations` に pnpm の `.pnpm/@vue+typescript-plugin@.../node_modules` を指定
- `--suppressDiagnosticEvents` で push 型の診断イベントを抑制
- tsconfig.json を `updateOpen` で開いてプロジェクトを認識させる（プラグイン初期化に必要）

### ファイル変更時の診断更新

- tsserver の `updateOpen`（close + reopen）でファイル内容を更新
- `updateOpen` のレスポンスを待ってから `semanticDiagnosticsSync` を送る

> [!WARNING]
> `changedFiles` の `textChanges` に `Number.MAX_SAFE_INTEGER` を行番号として使うと tsserver がエラーになる。全文置換は close + reopen で行う

## Worktree 切り替え対応

LSP クライアントは worktree 切り替え時に再起動する。

- `repoRootDir`（clone 元、固定）と `currentDir`（切り替え可能な worktree パス）を分離
- `windowLspClients`（`Map<win, LspClient[]>`）でウィンドウごとに LSP クライアントを管理
- worktree 切り替え時に既存 LSP クライアントを shutdown し、新しい worktree で再起動
- `resolveGitDir()` で `git rev-parse --git-dir` を使い、linked worktree の `.git` ファイルから実際の git ディレクトリを解決

### 世代管理

`windowSwitchGen`（世代番号）で並行リクエスト時の stale イベントを破棄する。worktree 切り替え時に世代番号をインクリメントし、LSP の diagnostic callback で世代が一致しない場合は結果を無視する。

## コード構成（`apps/desktop/src/lsp.ts`）

- `createFrameParser` — Content-Length フレーミングパーサー。LSP と tsserver で共通
- `createTsServerBridge` — tsserver プロセスの管理。bridge（Vue LSP ↔ tsserver のリクエストフォワード）と `semanticDiagnosticsSync` の実行
- `createLspClient` — LSP クライアント本体。tsgo / vue 両対応。tsgo の場合は pull diagnostics、vue の場合は tsserver bridge 経由で診断取得

## パス解決（`apps/desktop/src/index.ts`）

- `resolveTsgoPath` — `@typescript/native-preview-{platform}-{arch}` の tsgo バイナリを `node_modules` から探す
- `resolveVueLspPaths` — `@vue/language-server`、tsdk（`typescript/lib`）、`@vue/typescript-plugin` の pluginProbeLocation を pnpm `.pnpm` 配下から解決

## フロントエンド

- `useDiagnosticsStore`（Pinia store） — RPC の `lspDiagnostics` メッセージを購読し、`diagnosticsMap`（ファイルパス → 診断配列）をリアクティブに保持。worktree 切り替え時に `clear()` で診断マップをクリアする
- `DiagnosticsPane` — エラー・警告をファイルごとにグループ化して表示
