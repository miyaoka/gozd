# orkis — AI Agent Orchestrator

AI エージェントの Plan-Implement-Review ループを管理するデスクトップアプリケーション。

> [!NOTE]
> プロダクトの設計文書（コンセプト、ワークフロー、データモデル、エージェント連携等）は [docs/design.md](docs/design.md) を参照。

## 技術スタック

| レイヤー       | 技術                                        |
| -------------- | ------------------------------------------- |
| フレームワーク | Electron                                    |
| フロントエンド | Vue（+ TypeScript 5 / tsgo 7）              |
| ビルドツール   | Vite 8                                      |
| パッケージ管理 | pnpm（モノレポ + catalog）                  |
| CSS            | Tailwind CSS v4                             |
| アイコン       | Iconify（@iconify/tailwind4 + Lucide）      |
| フォーマッタ   | oxfmt                                       |
| リンター       | oxlint（TypeScript）/ ESLint（Vue）         |
| ターミナル     | xterm.js (WebGL renderer)                   |
| PTY            | node-pty                                    |
| ファイル監視   | @parcel/watcher                             |
| 差分表示       | Monaco Editor (createDiffEditor)（未実装）  |
| データ保存     | ローカルディレクトリ（JSON + マークダウン） |
| CLI            | orkis コマンド（fsss フレームワーク / bun） |

## ディレクトリ構成

```
orkis/
├── apps/
│   ├── electron/          # Electron メインプロセス
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── socket-server.ts  # CLI との Unix ドメインソケット通信
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   ├── cli/               # orkis CLI（fsss フレームワーク / bun）
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── socket-client.ts   # Electron へのソケット送信
│   │   │   └── commands/
│   │   │       ├── hook.ts        # orkis hook <event>
│   │   │       └── open.ts        # orkis open <path>
│   │   └── tsconfig.json
│   └── renderer/          # Vue フロントエンド
│       ├── src/
│       │   ├── main.ts
│       │   ├── App.vue
│       │   ├── assets/main.css
│       │   └── features/         # feature ごとに component, composable, store をまとめる
│       │       ├── debug/
│       │       │   └── DebugPane.vue
│       │       ├── filer/
│       │       │   ├── FilerPane.vue       # ファイルツリー表示
│       │       │   ├── FileTreeItem.vue    # 再帰的ツリーアイテム
│       │       │   └── useWorkspace.ts     # ワークスペース状態管理
│       │       ├── layout/
│       │       │   ├── MainLayout.vue
│       │       │   └── SidebarPane.vue
│       │       └── terminal/
│       │           └── TerminalPane.vue
│       ├── eslint.config.ts
│       ├── eslint.config.fix.ts
│       ├── vite.config.ts
│       └── tsconfig.json
├── packages/
│   ├── preload/           # Electron preload（contextBridge API）
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── index.d.ts
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   └── shared/            # 全パッケージ共通ユーティリティ
│       ├── src/
│       │   ├── index.ts
│       │   └── result.ts          # Result 型 + tryCatch
│       └── tsconfig.json
├── scripts/
│   └── watch.ts           # dev サーバー統合（renderer + preload + main）
├── docs/
│   └── design.md          # プロダクト設計文書
├── .github/
│   ├── actions/
│   │   └── setup-environment/  # CI 共通セットアップ
│   └── workflows/
│       └── code_validation.yml # PR の typecheck / lint
├── lefthook.yml
├── mise.toml
├── pnpm-workspace.yaml
├── renovate.json
├── tsconfig.json
└── package.json
```
