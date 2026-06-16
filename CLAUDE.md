# gozd — Git Orchestrated Zone for Development

AI エージェントの並列開発を管理するデスクトップアプリケーション。

シングルウィンドウ内に複数の repo（git リポジトリ）を同居させ、各 repo の worktree を切り替えて使う。各 worktree で Claude エージェントが独立して並列作業する。

@docs/architecture.md

## ドキュメント（`docs/`）

| ファイル                                  | 内容                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)   | **全体像**（起動フロー、通信経路、PTY 環境変数、Claude hooks）        |
| [workspace.md](docs/workspace.md)         | ワークスペース設計（マルチ repo、worktree 運用、UI 階層）             |
| [rpc.md](docs/rpc.md)                     | RPC スキーマ（proto 定義、request / message の全定義）                |
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

## 技術スタック

| レイヤー           | 技術                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| アプリ本体         | SwiftUI + WebKit（`WebPage` API、macOS 26 Tahoe 以降）                 |
| 言語               | Swift 6.2+（native）/ TypeScript（renderer）                           |
| フロントエンド     | Vue                                                                    |
| ビルドツール       | Vite（renderer）/ SwiftPM + シェルスクリプト（native `.app`）          |
| パッケージ管理     | pnpm（モノレポ + catalog）                                             |
| CSS                | Tailwind CSS v4                                                        |
| アイコン           | unplugin-icons（per-icon component import + Lucide）                   |
| フォーマッタ       | oxfmt                                                                  |
| リンター           | oxlint（TypeScript）/ ESLint（Vue）                                    |
| ターミナル         | xterm.js                                                               |
| PTY                | `forkpty`（C bridge）+ Swift PTYManager                                |
| ファイル監視       | FSEvents（Swift FSWatcher）                                            |
| RPC スキーマ       | Protocol Buffers（`.proto` SSOT、ts-proto + swift-protobuf）           |
| RPC トランスポート | `gozd-rpc://` URLSchemeHandler（双方向）+ Unix Domain Socket（NDJSON） |
| 差分表示           | diff（jsdiff）で行単位差分算出                                         |
| シンタックスHi     | Shiki                                                                  |
| Markdown           | marked + DOMPurify                                                     |
| ファイルアイコン   | material-icon-theme                                                    |
| データ保存         | ローカルディレクトリ（proto3 JSON）                                    |
| CLI                | `gozd-cli` バイナリ（Swift / SPM target）+ `bin/gozd` シェルラッパー   |

## ワークスペース構成

| パッケージ                    | 役割                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/native`                 | Swift メインアプリ + `gozd-cli`。`.app` バンドルを生成する                                                                           |
| `apps/renderer`               | Vue フロントエンド（WebKit 内で動作）                                                                                                |
| `packages/proto`              | `.proto` SSOT。buf で TS / Swift を生成                                                                                              |
| `packages/proto-ts`           | ts-proto 生成物。`@gozd/proto` として renderer が import                                                                             |
| `packages/proto-swift`        | swift-protobuf 生成物。`GozdProto` SPM パッケージとして native が import                                                             |
| `packages/eslint-plugin`      | 自前 ESLint プラグイン（barrel-import / isolateModules ルール）                                                                      |
| `packages/design-tokens`      | Tier 1 design tokens の primitives CSS（Adobe Leonardo で生成、prepare で build）                                                    |
| `packages/shared`             | 全パッケージ共通ユーティリティ（Result 型 + tryCatch）                                                                               |
| `packages/claude-session-log` | Claude Code セッションログ（JSONL）の解釈層。生 JSONL → transcript イベント列の純関数（framework 非依存、ログ形式変更の追従先 SSOT） |
| `packages/shiki-lang-map`     | 拡張子 / ファイル名 → Shiki BundledLanguage マップ（Linguist 由来、build 時 codegen）                                                |
| `packages/themes`             | ターミナルテーマ（iTerm2-Color-Schemes vendor + 変換ロジック）                                                                       |

## Feature ベースアーキテクチャ（renderer）

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

- `pnpm dev` — renderer（Vite HMR）と native（Swift app）を `pnpm --parallel --filter @gozd/renderer --filter @gozd/native dev` で同時起動
- `pnpm build` — 全パッケージをビルド（stable 環境の `.app` を生成）

全チェックはルートの `pnpm run test:all` / `pnpm run typecheck:all` で行う。pnpm 11 は `pnpm run` 実行時に node_modules を自動インストールするため、事前の手動 install は不要。

- import の整理（未使用 import の削除、並び替え）は commit 時に lint が自動実行する。手動で整理しない

## リリースステージとデータポリシー

gozd は現在 **ベータ版**。安定版リリース前であり、永続データ（`~/.config/gozd/` 配下 / `.proto` schema）に **後方互換性は作らない**。

- proto schema 進化（フィールド削除・rename・型変更）で旧 JSON が parse 失敗した場合、**新規初期化が期待挙動**。マイグレーションコード（旧フィールド読み替え・退避コピー・shallow merge による未知フィールド保持等）は書かない
- 破壊的変更を許容する。古い設定 / 永続データを「いつまでも動かす」ためのコードを足さない
- 永続化ストアの load 経路で proto JSON parse 失敗を検知したら空オブジェクトで上書き save する（`TaskStore` 参照）。stderr に reinit ログを残し観察可能性は保つ
- 安定版に切り替わる時点で本セクションを書き換える

## 現在のフォーカス

シングルウィンドウ + マルチ repo + マルチ worktree の運用環境（[workspace.md](docs/workspace.md)）。

### 方針決定済み

- git worktree 運用ルール（main は参照専用、作業は常に worktree で）
- worktree 配置（`~/.local/share/gozd/worktrees/`）
- ビュー状態の保持（切り替え時に破棄しない）
- 1 ウィンドウに複数 repo を同居させ、サイドバーに repo セクションを並列表示する

## 対応プラットフォーム

macOS 26 Tahoe 以降専用（`WebPage` API は macOS 26 で追加された SwiftUI の WebKit 統合）。Swift 側のパス処理は `URL` / `FileManager` を使い、リテラル区切り `/` をハードコードしない。

## コーディング規約

### 一時ファイル・ソケット

- `/tmp` をハードコードしない。Swift では `NSTemporaryDirectory()` を使う
- macOS ではユーザーごとに異なる TMPDIR（`/var/folders/...`）が割り当てられる。`/tmp` はグローバルなので、マルチユーザー環境やサンドボックスで衝突する

### エラーハンドリング（TypeScript）

- try-catch は使わず、`@gozd/shared` の `tryCatch` を使って Result 型で処理する
- `tryCatch(() => ...)` で同期処理、`tryCatch(promise)` で非同期処理をラップ
- 結果は `result.ok` で判定し、`result.value` / `result.error` でアクセスする

### 観察ログ (stderr) の書式

dispatcher / store / hook ハンドラの ad-hoc 観察ログは `GozdCore.StderrLog.write(tag:_:)` を使う。

```swift
StderrLog.write(tag: "handlePtySpawn", "pty.spawn failed: \(error) executable=\(req.executable) cwd=\(req.dir)")
```

- tag は handler 関数名 (`handlePtySpawn`) または store / module 名 (`TaskStore`)
- helper が `[tag] message\n` の format と制御文字 escape を引き受ける。call site は素の string interpolation を書く

`PTYError.errnoText` (`PTYManager.swift`) の control-char gate はこの helper と独立した契約。errnoText は `PTYError.description` 経由で `RpcSchemeHandler` の 500 response body にも乗り renderer まで届くため、stderr 経路の helper escape では identifier 品質を担保できず、`unknown errno N` fallback を errnoText 側で持つ。

trace 系統は専用 format / 専用 lock で別経路:

- `[PTY-TRACE +elapsed pid=N tag]` (`PTYTrace.swift`): PTY ライフサイクル
- `[TEST-TRACE +elapsed test=NAME]` (`TestTrace.swift`): test ハーネス

## Swift

### 型システム / safety 機構の無効化・回避は厳禁

**原則禁止:**
`@unchecked Sendable` / `nonisolated(unsafe)` / `as!`（force cast） / `!`（force unwrap） / `var x: T!`（implicitly unwrapped optional） / `try!` / `unsafeBitCast` / `Unmanaged.*` を C bridge 以外で使うこと

これらは TypeScript の `@ts-ignore` / `any` / `as` / `!` と同じ性質の escape hatch。コンパイラの責任を開発者の手動保証に肩代わりさせる仕組みであり、機械的に使うものではない。

**型 / 安全性のエラーが出たとき:**

- 型を緩めて黙らせる前に、なぜそのエラーが出ているか確認する
- Optional には `if let` / `guard let` / `??` で対処。`!` は使わない
- 型変換は `as?`（safe cast） + 失敗時のエラーで対処。`as!` は使わない
- Sendable エラーが出たら、そもそも Sendable にする必要があるか問う
  - actor を跨いで送る要件がなければ Sendable にしない（non-Sendable class として単一 context 所有）
  - 跨ぐ要件があるなら actor / 値型 / Copy-on-Write を検討
- C bridge（forkpty、FSEvents 等）で `Unmanaged.*` / `unsafeBitCast` を使う場合は、その箇所のみで使い、ラップした class は普通の Swift コードとして扱う
- それでも残る場合のみ最後の手段として escape hatch を使う。使うときは「なぜ自前で保証できるか」をコメントで明記する
