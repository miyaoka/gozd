# orkis — AI Agent Orchestrator

AI エージェントの Plan-Implement-Review ループを管理するデスクトップアプリケーション。

> [!NOTE]
> プロダクトの設計文書（コンセプト、ワークフロー、データモデル、エージェント連携等）は [docs/design.md](docs/design.md) を参照。

## 技術スタック

| レイヤー       | 技術                                        |
| -------------- | ------------------------------------------- |
| フレームワーク | Electron                                    |
| フロントエンド | Vue（+ TypeScript）                         |
| ビルドツール   | Vite                                        |
| パッケージ管理 | pnpm（モノレポ + catalog）                  |
| CSS            | Tailwind CSS v4                             |
| アイコン       | Iconify（@iconify/tailwind4 + Lucide）      |
| フォーマッタ   | oxfmt                                       |
| リンター       | oxlint（TypeScript）/ ESLint（Vue）         |
| ターミナル     | xterm.js (WebGL renderer)（未実装）         |
| PTY            | node-pty（未実装）                          |
| 差分表示       | Monaco Editor (createDiffEditor)（未実装）  |
| データ保存     | ローカルディレクトリ（JSON + マークダウン） |
| CLI            | orkis コマンド（フック用）                  |

## ディレクトリ構成

```
orkis/
├── apps/
│   ├── electron/          # Electron メインプロセス
│   │   ├── src/index.ts
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   └── renderer/          # Vue フロントエンド
│       ├── src/
│       │   ├── main.ts
│       │   ├── App.vue
│       │   └── assets/main.css
│       ├── eslint.config.ts
│       ├── eslint.config.fix.ts
│       ├── vite.config.ts
│       └── tsconfig.json
├── packages/
│   └── preload/           # Electron preload（contextBridge API）
│       ├── src/
│       │   ├── index.ts
│       │   └── index.d.ts
│       ├── vite.config.ts
│       └── tsconfig.json
├── scripts/
│   └── watch.ts           # dev サーバー統合（renderer + preload + main）
├── docs/
│   └── design.md          # プロダクト設計文書
├── lefthook.yml
├── mise.toml
├── pnpm-workspace.yaml
├── tsconfig.json
└── package.json
```
