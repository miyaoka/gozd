# orkis — AI Agent Orchestrator

AI エージェントの並列開発を管理するデスクトップアプリケーション。

シングルウィンドウで複数プロジェクト・複数 worktree をタブ的に切り替えて使う。各 worktree で Claude エージェントが独立して並列作業する。

## ドキュメント（`docs/`）

| ファイル                            | 内容                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| [design.md](docs/design.md)         | 初期構想（Todo/Plan/Review ループ。現在は workspace.md が優先）     |
| [workspace.md](docs/workspace.md)   | ワークスペース設計（並列プロジェクト、worktree 運用、UI 階層）      |
| [electrobun.md](docs/electrobun.md) | Electrobun アーキテクチャ、WKWebView の制約、ウィンドウ管理         |
| [rpc.md](docs/rpc.md)               | RPC スキーマ（request / message の全定義）                          |
| [filer.md](docs/filer.md)           | ファイラー（ツリー表示、git status 色分け、アイコン、ファイル監視） |
| [lsp.md](docs/lsp.md)               | LSP 型診断（tsgo、Vue tsserver bridge、diagnostics 取得方式）       |
| [preview.md](docs/preview.md)       | プレビュー（コード、diff、画像、SVG、Markdown、リアクティブ更新）   |
| [terminal.md](docs/terminal.md)     | ターミナル（xterm.js / ghostty-web 切り替え、PTY ライフサイクル）   |

## 技術スタック

| レイヤー         | 技術                                          |
| ---------------- | --------------------------------------------- |
| フレームワーク   | Electrobun（Bun ランタイム + WKWebView）      |
| フロントエンド   | Vue（+ TypeScript 5 / tsgo 7）                |
| ビルドツール     | Vite 8                                        |
| パッケージ管理   | pnpm（モノレポ + catalog）                    |
| CSS              | Tailwind CSS v4                               |
| アイコン         | Iconify（@iconify/tailwind4 + Lucide）        |
| フォーマッタ     | oxfmt                                         |
| リンター         | oxlint（TypeScript）/ ESLint（Vue）           |
| ターミナル       | xterm.js / ghostty-web（切り替え可）          |
| PTY              | Bun.spawn({ terminal })                       |
| ファイル監視     | node:fs.watch（recursive）                    |
| RPC              | Electrobun RPC（型安全な bun ↔ webview 通信） |
| 差分表示         | diff（jsdiff）で行単位差分算出                |
| シンタックスHi   | Shiki                                         |
| Markdown         | marked + mermaid + DOMPurify                  |
| ファイルアイコン | material-icon-theme                           |
| データ保存       | ローカルディレクトリ（JSON + マークダウン）   |
| CLI              | orkis コマンド（fsss フレームワーク / bun）   |

## ディレクトリ構成

```
orkis/
├── apps/
│   ├── desktop/           # Electrobun メインプロセス（PTY、ファイル監視、RPC、ソケットサーバー、LSP）
│   ├── cli/               # orkis CLI（fsss フレームワーク / bun）
│   └── renderer/          # Vue フロントエンド
│       └── src/features/  # feature ごとに component, composable, store をまとめる
│           ├── debug/       # デバッグ情報表示
│           ├── diagnostics/ # LSP 型診断パネル（tsgo + Vue）
│           ├── filer/       # ファイルツリー表示（material-icon-theme アイコン、git status 色分け）
│           ├── layout/      # レイアウト
│           ├── preview/     # ファイルプレビュー（コード、diff、画像、SVG、Markdown）
│           ├── rpc/         # Electrobun RPC composable
│           └── terminal/    # ターミナル
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

## 現在のフォーカス

並列プロジェクト・並列 worktree による開発環境の実現（[workspace.md](docs/workspace.md)）。

### 方針決定済み

- git worktree 運用ルール（main は参照専用、作業は常に worktree で）
- worktree 配置（`.orkis/worktrees/`）
- ビュー状態の保持（切り替え時に破棄しない）
- シングルウィンドウでプロジェクト・worktree をタブ的に切り替える

### 実装済み

- サイドバーに worktree 一覧・ブランチ一覧を表示
- worktree の作成・解除、ブランチからの worktree 化
- worktree クリック時のビュー切り替え（ファイル監視・LSP の付け替え）
- worktree 切り替え時のターミナル保持（PTY プロセスと xterm バッファの維持）

### 未着手

- workspace-scoped な状態管理（ファイラー・プレビューの状態を worktree ごとに保持）
- プロジェクト一覧の永続化（ストレージ方式の選定含む）
- シングルウィンドウ化（マルチウィンドウからの移行）

## コーディング規約

### エラーハンドリング

- try-catch は使わず、`@orkis/shared` の `tryCatch` を使って Result 型で処理する
- `tryCatch(() => ...)` で同期処理、`tryCatch(promise)` で非同期処理をラップ
- 結果は `result.ok` で判定し、`result.value` / `result.error` でアクセスする
