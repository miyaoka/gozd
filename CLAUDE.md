# gozd — Git Orchestrated Zone for Development

AI エージェントの並列開発を管理するデスクトップアプリケーション。

プロジェクト（git リポジトリ）ごとにウィンドウを持ち、ウィンドウ内で複数 worktree を切り替えて使う。各 worktree で Claude エージェントが独立して並列作業する。

@docs/architecture.md

## ドキュメント（`docs/`）

| ファイル                                  | 内容                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)   | **全体像**（起動フロー、通信経路、PTY 環境変数、Claude hooks）      |
| [workspace.md](docs/workspace.md)         | ワークスペース設計（並列プロジェクト、worktree 運用、UI 階層）      |
| [desktop.md](docs/desktop.md)             | Desktop メインプロセス（パス検証、プロトコル制限）                  |
| [electrobun.md](docs/electrobun.md)       | Electrobun アーキテクチャ、WKWebView の制約、ウィンドウ管理         |
| [rpc.md](docs/rpc.md)                     | RPC スキーマ（request / message の全定義）                          |
| [filer.md](docs/filer.md)                 | ファイラー（ツリー表示、git status 色分け、アイコン、ファイル監視） |
| [lsp.md](docs/lsp.md)                     | LSP 型診断（tsgo、Vue tsserver bridge、diagnostics 取得方式）       |
| [preview.md](docs/preview.md)             | プレビュー（コード、diff、画像、SVG、Markdown、リアクティブ更新）   |
| [terminal.md](docs/terminal.md)           | ターミナル（分割、worktree 保持、ファイルパスリンク、PTY 管理）     |
| [command.md](docs/command.md)             | コマンドシステム（レジストリ、context key、when 条件）              |
| [keybinding.md](docs/keybinding.md)       | キーバインディング（e.code ベース、設定フォーマット、解決フロー）   |
| [todo.md](docs/todo.md)                   | Todo 管理（作業計画、worktree 紐づけ、サイドバー UI）               |
| [claude-status.md](docs/claude-status.md) | Claude ステータス管理（状態遷移、hooks、interrupt 検知）            |

## ドキュメントの階層

| 階層           | 場所                        | 内容                                                                              | 例                                                               |
| -------------- | --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 横断設計       | `docs/*.md`                 | 機能の全体設計、feature 間の連携、データフロー                                    | docs/terminal.md — 分割ツリー設計、PTY ライフサイクル            |
| feature 内部   | `features/*/README.md`      | コンポーネントを持たない feature の実装詳細（変換ルール、文法、モジュール間依存） | features/command/README.md — パーサー文法、除外判定ロジック      |
| コンポーネント | Vue SFC の `<doc>` ブロック | 単一コンポーネントの責務、動作、注意点                                            | TerminalPane.vue — フラットレンダリング方式、leaf と rect の分離 |

- `docs/` は機能の「使い方・設計判断」、feature 内 README は「実装の内部知識」を担う
- Vue コンポーネントがある feature は `<doc>` ブロックで十分なことが多い。README が必要なのは非コンポーネントモジュールが多い feature のみ

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
| ターミナル       | xterm.js                                      |
| PTY              | Bun.spawn({ terminal })                       |
| ファイル監視     | node:fs.watch（recursive）                    |
| RPC              | Electrobun RPC（型安全な bun ↔ webview 通信） |
| 差分表示         | diff（jsdiff）で行単位差分算出                |
| シンタックスHi   | Shiki                                         |
| Markdown         | marked + mermaid + DOMPurify                  |
| ファイルアイコン | material-icon-theme                           |
| データ保存       | ローカルディレクトリ（JSON + マークダウン）   |
| CLI              | gozd コマンド（fsss フレームワーク / bun）    |

## ディレクトリ構成

```
gozd/
├── apps/
│   ├── desktop/           # Electrobun メインプロセス（PTY、ファイル監視、RPC、ソケットサーバー、LSP）
│   ├── cli/               # gozd CLI（fsss フレームワーク / bun）
│   └── renderer/          # Vue フロントエンド
│       └── src/features/  # feature ごとに component, composable, store をまとめる
│           ├── command/      # コマンドシステム + keybinding（e.code ベース、context key）
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
├── docs/                  # 設計文書
└── .github/               # CI ワークフロー
```

## 開発コマンド

- `pnpm dev` — renderer（Vite HMR）と desktop（Electrobun dev）を `concurrently` で同時起動。片方が終了すると他方も終了する
- `pnpm build` — 全パッケージをビルド（stable 環境の `.app` を生成）

全体チェックはルートの `pnpm typecheck:all` / `lint:all` / `test:all` を使う。各 workspace の同名スクリプトを一括実行する。

## 現在のフォーカス

並列プロジェクト・並列 worktree による開発環境の実現（[workspace.md](docs/workspace.md)）。

### 方針決定済み

- git worktree 運用ルール（main は参照専用、作業は常に worktree で）
- worktree 配置（`.gozd/worktrees/`）
- ビュー状態の保持（切り替え時に破棄しない）
- プロジェクトごとにウィンドウを分離し、ウィンドウ内で worktree を切り替える

### 実装済み

- サイドバーに worktree 一覧・ブランチ一覧を表示
- worktree の作成・解除、ブランチからの worktree 化
- worktree クリック時のビュー切り替え（ファイル監視・LSP の付け替え）
- worktree 切り替え時のターミナル保持（PTY プロセスと xterm バッファの維持）
- アプリ状態の復元（最後に開いたプロジェクト・ウィンドウフレームを起動時に再現）

### 未着手

- workspace-scoped な状態管理（ファイラー・プレビューの状態を worktree ごとに保持）
- プロジェクト一覧の永続化（ストレージ方式の選定含む）

## クロスプラットフォーム方針

現状は macOS 専用アプリ（Electrobun / WKWebView）だが、パス処理などプラットフォーム依存が生じるコードはクロスプラットフォームを前提に書く。

- パス区切りのリテラル（`/`、`\\`）をハードコードしない。`path.sep`、`path.join()`、`path.resolve()` を使う
- root 外判定は `relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)` のイディオムを使う

## コーディング規約

### 一時ファイル・ソケット

- `/tmp` をハードコードしない。`os.tmpdir()`（Node.js）を使う
- macOS ではユーザーごとに異なる TMPDIR（`/var/folders/...`）が割り当てられる。`/tmp` はグローバルなので、マルチユーザー環境やサンドボックスで衝突する

### エラーハンドリング

- try-catch は使わず、`@gozd/shared` の `tryCatch` を使って Result 型で処理する
- `tryCatch(() => ...)` で同期処理、`tryCatch(promise)` で非同期処理をラップ
- 結果は `result.ok` で判定し、`result.value` / `result.error` でアクセスする
