# orkis — AI Agent Orchestrator

AI エージェントの Plan-Implement-Review ループを管理するデスクトップアプリケーション。

マルチウィンドウ前提のアプリケーション。ディレクトリごとに1ウィンドウを開き、同じディレクトリを複数開くことはできない（VS Code と同じモデル）。

> [!NOTE]
> プロダクトの設計文書（コンセプト、ワークフロー、データモデル、エージェント連携等）は [docs/design.md](docs/design.md) を参照。

## 技術スタック

| レイヤー       | 技術                                          |
| -------------- | --------------------------------------------- |
| フレームワーク | Electrobun（Bun ランタイム + WKWebView）      |
| フロントエンド | Vue（+ TypeScript 5 / tsgo 7）                |
| ビルドツール   | Vite 8                                        |
| パッケージ管理 | pnpm（モノレポ + catalog）                    |
| CSS            | Tailwind CSS v4                               |
| アイコン       | Iconify（@iconify/tailwind4 + Lucide）        |
| フォーマッタ   | oxfmt                                         |
| リンター       | oxlint（TypeScript）/ ESLint（Vue）           |
| ターミナル     | ghostty-web                                   |
| PTY            | Bun.spawn({ terminal })                       |
| ファイル監視   | node:fs.watch（recursive）                    |
| RPC            | Electrobun RPC（型安全な bun ↔ webview 通信） |
| 差分表示       | Monaco Editor (createDiffEditor)（未実装）    |
| データ保存     | ローカルディレクトリ（JSON + マークダウン）   |
| CLI            | orkis コマンド（fsss フレームワーク / bun）   |

## ディレクトリ構成

```
orkis/
├── apps/
│   ├── desktop/           # Electrobun メインプロセス（PTY、ファイル監視、RPC、ソケットサーバー）
│   ├── cli/               # orkis CLI（fsss フレームワーク / bun）
│   └── renderer/          # Vue フロントエンド
│       └── src/features/  # feature ごとに component, composable, store をまとめる
│           ├── debug/     # デバッグ情報表示
│           ├── filer/     # ファイルツリー表示
│           ├── layout/    # レイアウト
│           ├── rpc/       # Electrobun RPC composable
│           └── terminal/  # ターミナル
├── packages/
│   ├── rpc/               # RPC スキーマ型定義（bun ↔ webview）
│   └── shared/            # 全パッケージ共通ユーティリティ（Result 型 + tryCatch）
├── bin/                   # CLI エントリポイント（アプリ自動起動 + CLI 実行）
├── docs/                  # 設計文書
└── .github/               # CI ワークフロー
```

## 開発コマンド

- `pnpm dev` — renderer（Vite HMR）と desktop（Electrobun dev）を `concurrently` で同時起動。片方が終了すると他方も終了する
- `pnpm build` — 全パッケージをビルド
- `pnpm start` — ビルド済みアプリを起動
- `bin/orkis` — 開発用エントリポイント。アプリ未起動なら自動で build → start し、ソケット経由で CLI コマンドを送信する。残骸ソケットは `nc -zU` で検出・削除する

全体チェックはルートの `pnpm typecheck:all` / `lint:all` / `test:all` を使う。各 workspace の同名スクリプトを一括実行する。

## コーディング規約

### エラーハンドリング

- try-catch は使わず、`@orkis/shared` の `tryCatch` を使って Result 型で処理する
- `tryCatch(() => ...)` で同期処理、`tryCatch(promise)` で非同期処理をラップ
- 結果は `result.ok` で判定し、`result.value` / `result.error` でアクセスする
