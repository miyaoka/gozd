# gozd — Git Orchestrated Zone for Development

AI エージェントの並列開発を管理するデスクトップアプリケーション。

シングルウィンドウ内に複数の repo（git リポジトリ）を同居させ、各 repo の worktree を切り替えて使う。各 worktree で Claude エージェントが独立して並列作業する。

> [!IMPORTANT]
> gozd は Electron のデスクトップアプリであり、Chrome では確認できない。ブラウザ自動化で画面を検証しようとしない。

@docs/architecture.md

## ドキュメント（`docs/`）

| ファイル                                  | 内容                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)   | **全体像**（起動フロー、通信経路、PTY 環境変数、Claude hooks）        |
| [workspace.md](docs/workspace.md)         | ワークスペース設計（マルチ repo、worktree 運用、UI 階層）             |
| [rpc.md](docs/rpc.md)                     | RPC スキーマ（@gozd/rpc の型 SSOT、通信モデル、購読契約）             |
| [git.md](docs/git.md)                     | git / GitHub 連携（RPC 一覧、push 経路、更新トリガー、gh エラー分類） |
| [filer.md](docs/filer.md)                 | ファイラー（ツリー表示、git status 色分け、アイコン、ファイル監視）   |
| [preview.md](docs/preview.md)             | プレビュー（コード、diff、画像、SVG、Markdown、リアクティブ更新）     |
| [terminal.md](docs/terminal.md)           | ターミナル（分割、worktree 保持、ファイルパスリンク、PTY 管理）       |
| [command.md](docs/command.md)             | コマンドシステム（レジストリ、context key、when 条件）                |
| [keybinding.md](docs/keybinding.md)       | キーバインディング（e.code ベース、設定フォーマット、解決フロー）     |
| [task.md](docs/task.md)                   | Task 管理（作業計画、worktree 紐づけ、サイドバー UI）                 |
| [claude-status.md](docs/claude-status.md) | Claude ステータス管理（状態遷移、hooks、interrupt 検知）              |
| [server.md](docs/server.md)               | サーバー検出（LISTEN port ポーリング、worktree 帰属、一覧パネル）     |

## ドキュメントの階層

| 階層           | 場所                        | 内容                                                                               | 例                                                               |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 横断設計       | `docs/*.md`                 | 機能の全体設計、feature 間の連携、データフロー                                     | docs/terminal.md — 分割ツリー設計、PTY ライフサイクル            |
| モジュール内部 | `**/README.md`              | コンポーネントを持たないモジュールの実装詳細（変換ルール、文法、モジュール間依存） | shared/command/README.md — パーサー文法、除外判定ロジック        |
| コンポーネント | Vue SFC の `<doc>` ブロック | 単一コンポーネントの責務、動作、注意点                                             | TerminalPane.vue — フラットレンダリング方式、leaf と rect の分離 |

- `docs/` は機能の「使い方・設計判断」、feature 内 README は「実装の内部知識」を担う
- Vue コンポーネントがある feature は `<doc>` ブロックで十分なことが多い。README が必要なのは非コンポーネントモジュールが多い feature のみ

### ドキュメントは「なぜ」を書く。実装は書かない

全レイヤー（`docs/*.md` / README / SFC `<doc>` / module docstring）共通の原則。ドキュメントは目的・責務・
非自明な設計判断（なぜそうするか）を書き、実装そのものは書かない。判定基準は「**実装を変えたら追従が
必要になる記述は書かない**」。腐る記述の典型:

- ファイル / コンポーネント / feature 構成の一覧、ディレクトリ構成、パス
- 「barrel が何を公開・隠蔽するか」等の構造説明、参照元・利用側の列挙
- コードを読めば分かる処理手順の逐条化、Props / シグネチャの転記

構造は実装を見れば分かる。ドキュメントには、コードを読んでも分からないこと（設計意図、ブラウザ挙動、
アルゴリズム不変条件、レイヤー間の契約）だけを残す。SFC `<doc>` の詳細は `apps/renderer/CLAUDE.md` を参照。

## 技術スタック

| レイヤー           | 技術                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| アプリ本体         | Electron（main process = TypeScript、esbuild で bundle）                    |
| 言語               | TypeScript（一言語構成）                                                    |
| フロントエンド     | Vue                                                                         |
| ビルドツール       | Vite（renderer）/ esbuild（main / preload / cli）/ electron-builder（.app） |
| パッケージ管理     | pnpm（モノレポ + catalog、nodeLinker: hoisted）                             |
| CSS                | Tailwind CSS v4                                                             |
| アイコン           | unplugin-icons（per-icon component import + Lucide）                        |
| フォーマッタ       | oxfmt                                                                       |
| リンター           | oxlint（TypeScript）/ ESLint（Vue）                                         |
| ターミナル         | xterm.js                                                                    |
| PTY                | node-pty                                                                    |
| ファイル監視       | @parcel/watcher（FSEvents backend）                                         |
| RPC スキーマ       | 共有 TS 型パッケージ（`@gozd/rpc`。ワイヤは素の JSON、codec レス）          |
| RPC トランスポート | contextBridge + ipcMain/ipcRenderer + Unix Domain Socket（NDJSON）          |
| 差分表示           | diff（jsdiff）で行単位差分算出                                              |
| シンタックスHi     | Shiki                                                                       |
| Markdown           | marked + DOMPurify                                                          |
| ファイルアイコン   | material-icon-theme                                                         |
| データ保存         | ローカルディレクトリ（JSON。schema は `@gozd/rpc` と共有）                  |
| CLI                | `gozd-cli`（TS、`ELECTRON_RUN_AS_NODE` で実行）+ `bin/gozd` シェルラッパー  |

## ワークスペース構成

| パッケージ                    | 役割                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/electron`               | Electron main process + `gozd-cli`（TS）。electron-builder で `.app` バンドルを生成する                                              |
| `apps/renderer`               | Vue フロントエンド（Electron renderer 内で動作）                                                                                     |
| `packages/rpc`                | RPC message / 永続化 schema の型 SSOT（手書き TS）。`@gozd/rpc` として renderer / electron が import                                 |
| `packages/eslint-plugin`      | 自前 ESLint プラグイン（barrel-import / isolateModules ルール）                                                                      |
| `packages/design-tokens`      | Tier 1 design tokens の primitives CSS（Adobe Leonardo で生成、prepare で build）                                                    |
| `packages/shared`             | 全パッケージ共通の型・定数・ユーティリティ（Result 型 + tryCatch、RPC ブリッジ契約、window chrome 定数）                             |
| `packages/claude-session-log` | Claude Code セッションログ（JSONL）の解釈層。生 JSONL → transcript イベント列の純関数（framework 非依存、ログ形式変更の追従先 SSOT） |
| `packages/shiki-lang-map`     | 拡張子 / ファイル名 → Shiki BundledLanguage マップ（Linguist 由来、build 時 codegen）                                                |
| `packages/themes`             | ターミナルテーマ（iTerm2-Color-Schemes vendor + 変換ロジック）                                                                       |

## Feature ベースアーキテクチャ（renderer）

コードを機能単位のまとまりに区切り、まとまりどうしが余計に絡み合わないようにする。こうすると各機能を
単独で直せ、変更が他へ漏れない。あるまとまりの内側にそれだけで成り立つ機能が生じたら、同じ区切りを
内側にも適用し feature を入れ子にする。

renderer の `src/` は **feature** と **shared** の 2 層で構成する。

### レイヤー

| レイヤー | パス              | 役割                                                                |
| -------- | ----------------- | ------------------------------------------------------------------- |
| feature  | `src/features/*/` | UI 機能単位。コンポーネント・composable・store をまとめる           |
| shared   | `src/shared/*/`   | feature に依存しない非 UI 基盤モジュール（RPC、コマンドシステム等） |

依存方向: **feature → shared は許可、shared → feature は禁止**。下位層が上位層に依存してはいけない。

shared の制約:

- shared 間の依存は禁止（`isolateModules` lint ルールで強制）。各モジュールは独立して閉じる

### バレルファイル（index.ts）

各 feature / shared にはバレルファイル `index.ts` を置き、公開 API を re-export する。外部からは `index.ts` 経由でのみ import できる。

```typescript
// OK: バレル経由
import { useRpc } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";

// NG: 内部モジュールの直接 import
import { useRpc } from "../../shared/rpc/useRpc";
import { useTerminalStore } from "../terminal/useTerminalStore";
```

`@gozd/eslint-plugin` の `barrel-import` ルールがこれを強制する。違反すると lint エラーになる。

### ルール

- 別パッケージのファイルを相対パスで参照しない。必ずパッケージ名（`@gozd/themes` 等）で import する
- feature / shared の外部からは `index.ts` のみ参照可能。内部モジュールを直接 import しない
- 同一 feature / shared 内のファイル間は自由に参照できる
- feature は再帰的にネスト可能。子 feature は `features/` サブディレクトリに配置する（例: `sidebar/features/worktree/`、`sidebar/features/task/`）
- feature / shared のディレクトリ名は lowercase、複合語は kebab-case（`git-graph`）
- `.ts` ファイル名は camelCase（`filerUtils.ts`）。Vue SFC は PascalCase（`FilerPane.vue`）

## 開発コマンド

- `pnpm dev` — renderer（Vite HMR）と Electron shell を concurrently で同時起動
- `pnpm --filter @gozd/electron build:app` — `.app` バンドルを生成（`apps/electron/out/mac-arm64/Gozd.app`）

全チェックはルートの `pnpm run test:all` / `pnpm run typecheck:all` で行う。pnpm 11 は `pnpm run` 実行時に node_modules を自動インストールするため、事前の手動 install は不要。

- import の整理（未使用 import の削除、並び替え）は commit 時に lint が自動実行する。手動で整理しない

## リリースステージとデータポリシー

gozd は現在 **ベータ版**。安定版リリース前であり、永続データ（`~/.config/gozd/` 配下 / `@gozd/rpc` の schema 型）に **後方互換性は作らない**。

- schema 進化（フィールド削除・rename・型変更）で旧 JSON が parse 失敗した場合、**新規初期化が期待挙動**。マイグレーションコード（旧フィールド読み替え・退避コピー・shallow merge による未知フィールド保持等）は書かない
- 破壊的変更を許容する。古い設定 / 永続データを「いつまでも動かす」ためのコードを足さない
- 永続化ストアの load 経路で JSON parse 失敗を検知したら空オブジェクトで上書き save する（`TaskStore` 参照）。stderr に reinit ログを残し観察可能性は保つ
- 安定版に切り替わる時点で本セクションを書き換える

## 対応プラットフォーム

macOS 専用（`bin/gozd` ラッパー、zsh init チェーン、`open` 経由の cold start 等が macOS 前提）。パス処理は `node:path` の `join` / `resolve` を使い、リテラル区切り `/` をハードコードしない。

## コーディング規約

### 一時ファイル・ソケット

- `/tmp` をハードコードしない。`node:os` の `tmpdir()` を使う
- macOS ではユーザーごとに異なる TMPDIR（`/var/folders/...`）が割り当てられる。`/tmp` はグローバルなので、マルチユーザー環境やサンドボックスで衝突する

### エラーハンドリング（TypeScript）

- try-catch は使わず、`@gozd/shared` の `tryCatch` を使って Result 型で処理する
- `tryCatch(() => ...)` で同期処理、`tryCatch(promise)` で非同期処理をラップ
- 結果は `result.ok` で判定し、`result.value` / `result.error` でアクセスする

### 観察ログ (stderr) の書式

dispatcher / store / hook ハンドラの ad-hoc 観察ログは `console.error` で `[tag] message` 形式に統一する。

```typescript
console.error(
  `[handlePtySpawn] pty.spawn failed: ${error} executable=${req.executable} cwd=${req.dir}`,
);
```

- tag は handler 関数名（`handlePtySpawn`）または store / module 名（`TaskStore`）
- silent drop 禁止: 握りつぶす失敗経路には必ず観察ログを残す（1 度の取りこぼしで UI 状態が永続的にずれる push 経路が典型）
