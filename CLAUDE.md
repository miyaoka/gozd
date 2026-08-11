# gozd — Git Orchestrated Zone for Development

AI エージェントの並列開発を管理するデスクトップアプリケーション。

シングルウィンドウ内に複数の repo（git リポジトリ）を同居させ、各 repo の worktree を切り替えて使う。各 worktree で Claude エージェントが独立して並列作業する。

> [!IMPORTANT]
> gozd は Electron のデスクトップアプリであり、Chrome では確認できない。ブラウザ自動化で画面を検証しようとしない。

@docs/architecture.md

## ドキュメント（`docs/`）

| ファイル                                  | 内容                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)   | **全体像**（起動フロー、通信経路、PTY 環境変数、Claude hooks）              |
| [workspace.md](docs/workspace.md)         | ワークスペース設計（マルチ repo、worktree 運用、UI 階層）                   |
| [rpc.md](docs/rpc.md)                     | RPC スキーマ（@gozd/rpc の型 SSOT、通信モデル、購読契約）                   |
| [git.md](docs/git.md)                     | git / GitHub 連携（push 経路、更新トリガー、gh エラー分類）                 |
| [filer.md](docs/filer.md)                 | ファイラー（ツリー表示、git status 色分け、アイコン、ファイル監視）         |
| [preview.md](docs/preview.md)             | プレビュー（コード、diff、画像、SVG、Markdown、リアクティブ更新）           |
| [terminal.md](docs/terminal.md)           | ターミナル（分割、worktree 保持、ファイルパスリンク、PTY 管理）             |
| [command.md](docs/command.md)             | コマンドシステム（レジストリ、context key、when 条件）                      |
| [keybinding.md](docs/keybinding.md)       | キーバインディング（e.code ベース、設定フォーマット、解決フロー）           |
| [task.md](docs/task.md)                   | Task 管理（作業計画、worktree 紐づけ、サイドバー UI、ダッシュボード）       |
| [claude-status.md](docs/claude-status.md) | Claude ステータス管理（状態遷移、hooks、interrupt 検知）                    |
| [server.md](docs/server.md)               | サーバー検出（LISTEN port ポーリング、worktree 帰属、一覧パネル）           |
| [release.md](docs/release.md)             | リリースと配布（canary / stable、CI、mise、wrapper 同期、channel identity） |

## ドキュメントの階層

| 階層             | 場所                        | 内容                                                       |
| ---------------- | --------------------------- | ---------------------------------------------------------- |
| 機能の契約       | `docs/*.md`                 | 機能の責務、観測可能な振る舞い、feature 間の契約           |
| モジュールの契約 | `**/README.md`              | そのモジュールの責務と公開 API、利用側への要求             |
| コンポーネント   | Vue SFC の `<doc>` ブロック | 単一コンポーネントの責務と、コードを読んでも分からない前提 |

- feature 内の README は既定では要らない。`docs/` の機能契約と `<doc>` で足りる。置くのは feature が
  複雑化して、モジュール単体で語るべき契約が機能契約とは別粒度で立ったときだけ
- `docs/` が機能をまたぐ契約、README がモジュール単体の契約を担う。**同じ内容を両方に書かない** —
  重複すると片方だけ直され、同じ誤りが 2 コピー残る

### `docs/` を指すときはファイル名で書く

コードから機能ドキュメントを参照するときは `docs/preview.md` のようにファイル名だけを書き、
相対パスのリンクにしない。節を指すなら `docs/filer.md` の「symlink の表示」のように節名を書く。
`<doc>` ブロック・JSDoc・行コメントのいずれでも同じ。

**相対パスは参照先の事実ではなく、参照元がどこに置かれているかで決まる値**であり、ファイルを
移動しただけで壊れる。壊れても typecheck / lint には掛からないため、誤りが残り続ける。`docs/` は
repo root 直下に固定でファイル名も機能名と一致するため、名前だけで到達できる。

例外は README.md からの参照で、こちらは GitHub が描画してリンクが実際に機能するため相対パスで
書いてよい。この線引きは「そのリンクを踏む相手がいるか」で決まる。

## 技術スタック

| レイヤー           | 技術                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| アプリ本体         | Electron（main process = TypeScript、esbuild で bundle）                    |
| 言語               | TypeScript（一言語構成）                                                    |
| フロントエンド     | Vue                                                                         |
| ビルドツール       | Vite（renderer）/ esbuild（main / preload / cli）/ electron-builder（.app） |
| パッケージ管理     | pnpm（モノレポ + catalog、nodeLinker: hoisted）                             |
| CSS                | Tailwind CSS v4                                                             |
| アイコン           | unplugin-icons（per-icon component import）                                 |
| フォーマッタ       | oxfmt                                                                       |
| リンター           | oxlint（TypeScript）/ ESLint（Vue）                                         |
| ターミナル         | xterm.js                                                                    |
| PTY                | node-pty                                                                    |
| ファイル監視       | @parcel/watcher（FSEvents backend）                                         |
| RPC スキーマ       | 共有 TS 型パッケージ（`@gozd/rpc`。ワイヤは structured clone、codec レス）  |
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
| `packages/eslint-plugin`      | 自前 ESLint プラグイン（`no-define-expose` / `no-iconify-class` / `no-raw-tailwind-palette`）                                        |
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

| レイヤー | パス              | 役割                                                                                             |
| -------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| feature  | `src/features/*/` | UI 機能単位。コンポーネント・composable・store をまとめる                                        |
| shared   | `src/shared/*/`   | feature に依存しない基盤モジュール（RPC、コマンドシステム、複数 feature が共有する表示語彙など） |

依存方向: **feature → shared は許可、shared → feature は禁止**。下位層が上位層に依存してはいけない。

shared の制約:

- shared 間の依存は禁止（`barrel-import` ルールの scope 設定で強制）。各モジュールは独立して閉じる
- コンポーネントは置かない。UI を描く材料（design token を指す class 名など）は、**どの feature
  にも属さず複数 feature が同じ値を見る必要があるときだけ**置く。特定の機能に属する語彙は
  feature 側が持つ

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

外部プラグイン `@miyaoka/eslint-plugin-barrel-import` の `barrel-import` ルールがこれを強制する。違反すると lint エラーになる。

### ルール

- 別パッケージのファイルを相対パスで参照しない。必ずパッケージ名（`@gozd/themes` 等）で import する
- feature / shared の外部からは `index.ts` のみ参照可能。内部モジュールを直接 import しない
- 同一 feature / shared 内のファイル間は自由に参照できる
- feature は再帰的にネスト可能。子 feature は `features/` サブディレクトリに配置する（例: `sidebar/features/worktree/`、`sidebar/features/task/`）
- feature / shared のディレクトリ名は lowercase、複合語は kebab-case（`git-graph`）
- `.ts` ファイル名は camelCase（`filerUtils.ts`）。Vue SFC は PascalCase（`FilerPane.vue`）

## 開発コマンド

- `pnpm dev` — renderer（Vite HMR）と Electron shell を concurrently で同時起動。port / socket は
  worktree 単位で分離されるため、複数 worktree での並列起動が可能
- `pnpm --filter @gozd/electron build:app` — `.app` バンドルを生成（無指定は local channel の
  `apps/electron/out/mac-arm64/Gozd Local.app`。stable identity は release CI のみ。docs/release.md）

全チェックはルートの `pnpm run typecheck:all` / `pnpm run lint:all` / `pnpm run test:all` / `pnpm run build:all` / `pnpm run knip` で行う（CI の `code_validation.yml` matrix 5 本と同一）。`fix` は commit 時の hook が担うため手動実行は不要で、PR の gate にも入れない。取りこぼした整形差分は `daily-fix.yml` が日次で `fix:all` を全件実行し、bot PR + auto merge で返済する。pnpm 11 は `pnpm run` 実行時に node_modules を自動インストールするため、事前の手動 install は不要。

- import の整理（未使用 import の削除、並び替え）は commit 時に lint が自動実行する。手動で整理しない

## リリースステージとデータポリシー

gozd は現在 **ベータ版**。安定版リリース前であり、永続データ（`~/.config/gozd/` 配下 / `@gozd/rpc` の schema 型）に **後方互換性は作らない**。

- schema 進化（フィールド削除・rename・型変更）で旧 JSON が parse 失敗した場合、**新規初期化が期待挙動**。旧バージョンが書いたファイルを読み続けるためのマイグレーションコードは書かない
- 破壊的変更を許容する。古い設定 / 永続データを「いつまでも動かす」ためのコードを足さない
- **これは保証しない側の宣言であって、既存データの削除を要求するものではない**。動かし続けるための
  コードを足さないだけで、消すためのコードも足さない
- 永続化ストアの load 経路で JSON parse 失敗を検知したら空オブジェクトで上書き save する。stderr に reinit ログを残し観察可能性は保つ
- 安定版に切り替わる時点で、本セクションと [architecture.md](docs/architecture.md) のベータ版節を書き換える

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

main の dispatcher / store / hook ハンドラの ad-hoc 観察ログは `console.error` で `[tag] message` 形式に統一する。

```typescript
console.error(
  `[handlePtySpawn] pty.spawn failed: ${error} executable=${req.executable} cwd=${req.dir}`,
);
```

- tag は handler 関数名（`handlePtySpawn`）または store / module 名（`TaskStore`）
- silent drop 禁止: 握りつぶす失敗経路には必ず観察ログを残す（1 度の取りこぼしで UI 状態が永続的にずれる push 経路が典型）
- 分類だけでなく原因も残す。「失敗した」ことだけを記録して例外や stderr を捨てると、後から何が起きたかを再構築できない
