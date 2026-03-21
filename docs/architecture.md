# アーキテクチャ

アプリの起動から通信までの全体像。各レイヤーがどう繋がるかを把握するためのドキュメント。

## レイヤー構成

```text
┌─────────────────────────────────────────────┐
│  renderer (Vue)                             │
│  apps/renderer/                             │
│  WKWebView 内で動作するフロントエンド       │
└────────────────┬────────────────────────────┘
                 │ Electrobun RPC（型安全な双方向通信）
┌────────────────┴────────────────────────────┐
│  desktop (Bun)                              │
│  apps/desktop/                              │
│  メインプロセス。PTY, ファイル監視, LSP,    │
│  ソケットサーバー, ウィンドウ管理           │
└────────────────┬────────────────────────────┘
                 │ Unix ドメインソケット（NDJSON）
┌────────────────┴────────────────────────────┐
│  cli (Bun)                                  │
│  apps/cli/                                  │
│  gozd コマンド。open / hook サブコマンド    │
└─────────────────────────────────────────────┘
```

## ビルドと `.app` の構造

Electrobun は dev / build どちらでも `.app` バンドルを生成して実行する。`import.meta.dir` は常に `.app/Contents/Resources/app/bun/` を指す。

### `.app` 内の配置（`electrobun.config.ts` の `build.copy`）

```text
gozd.app/Contents/
├── MacOS/bun          # Electrobun が提供する Bun ランタイム
└── Resources/app/
    ├── bun/index.js   # desktop のバンドル（import.meta.dir はここ）
    ├── views/main/    # renderer のビルド成果物（← @gozd/renderer/dist/）
    ├── bin/gozd      # CLI のエントリポイント（← @gozd/cli/bin/）
    ├── cli/index.js   # CLI のバンドル（← @gozd/cli/dist/）★ build のみ
    └── zsh/           # zsh 初期化ファイル（← apps/desktop/zsh/）
```

> [!WARNING]
> `cli/index.js` は `pnpm build` でのみ生成される。`pnpm dev`（`electrobun dev`）では `@gozd/cli` のビルドが走らないため `.app` 内に `cli/` は存在しない。
> そのため dev 時の `GOZD_CLI_PATH` は `.app` 内のパスではなく、ソースから直接 `bun apps/cli/src/index.ts` で実行する。

### `bin/gozd` シェルスクリプトの動作

`apps/cli/bin/gozd` は bash スクリプトで、`.app` 内の相対パスから Bun（`Contents/MacOS/bun`）と CLI エントリポイント（`cli/index.js`）を解決する。

- **cold start**（アプリ未起動）: CLI が launch request ファイルを書き出し → `open` で `.app` を起動 → desktop が request を読み取ってウィンドウ作成
- **warm start**（アプリ起動済み）: CLI がソケット経由で `open` メッセージを送信 → desktop が処理
- **hook コマンド**: アプリ起動チェックをスキップし、直接実行

## 起動フロー

### `pnpm dev`（開発時）

- `concurrently` で renderer（Vite HMR）と desktop（Electrobun dev）を同時起動
- desktop の dev スクリプト: `GOZD_DEV_PROJECT_ROOT=$PWD pnpm exec electrobun dev`
- `GOZD_DEV_PROJECT_ROOT` は dev 時のみ存在し、プロジェクトルートを指す。初期ウィンドウのディレクトリと CLI パスの解決に使用
- renderer は `http://localhost:5173`（Vite dev server）に接続。HMR 有効

### `pnpm build` → `.app` 起動（本番）

- `pnpm -r build` で全パッケージをビルド（CLI の `dist/` も生成される）
- `electrobun build --env=stable` で `.app` を生成
- 起動方法: Dock / Finder から直接、または `gozd <path>` CLI 経由

### channel によるパス分離

`Updater.localInfo.channel()` で `"dev"` / `"stable"` を判定し、ソケットや設定ファイルのパスを分離する。dev と stable が同時実行可能。

| リソース          | パス                                          |
| ----------------- | --------------------------------------------- |
| ソケット          | `$TMPDIR/gozd-{channel}.sock`                 |
| launch request    | `$TMPDIR/gozd-{channel}-launch/`              |
| Claude hooks 設定 | `$TMPDIR/gozd-{channel}-claude-settings.json` |

## 通信経路

### Electrobun RPC（desktop ↔ renderer）

型安全な双方向通信。スキーマは `packages/rpc/` で定義。

- **request**（応答あり）: `renderer → desktop`。ptySpawn, fsReadFile, switchDir 等
- **message**（一方向）: 双方向。`renderer → desktop`（ptyWrite, ptyKill 等）、`desktop → renderer`（ptyData, gozdHook, fsChange 等）

### Unix ドメインソケット（cli → desktop）

NDJSON（改行区切り JSON）プロトコル。メッセージ型:

- `HookMessage`: `{ type: "hook", event, payload }` — Claude Code hooks からの状態通知
- `OpenMessage`: `{ type: "open", targetPath }` — プロジェクトを開く

## PTY と環境変数

desktop が PTY を spawn する時に以下の環境変数を注入する（`index.ts` の `spawnPty`）。

### gozd 固有の環境変数

| 変数                        | 用途                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `GOZD_PTY_ID`               | PTY の識別子。hooks イベントの発火元を特定する                       |
| `GOZD_SOCKET_PATH`          | ソケットパス。CLI や hooks コマンドが接続先に使う                    |
| `GOZD_CLI_PATH`             | gozd CLI の絶対パス。hooks コマンドが使用。dev と build で値が異なる |
| `GOZD_CLI_RUNNER`           | CLI のランナー。dev 時は `bun`、build 時は空文字列                   |
| `GOZD_CLAUDE_SETTINGS_PATH` | Claude hooks 設定ファイルのパス。`claude()` が参照                   |
| `GOZD_ZDOTDIR`              | gozd の zsh 初期化ディレクトリ                                       |
| `GOZD_ORIG_ZDOTDIR`         | ユーザーの元の ZDOTDIR（gozd が上書きする前の値）                    |

#### `GOZD_CLI_PATH` の解決

| 環境  | `GOZD_CLI_PATH`                                    | `GOZD_CLI_RUNNER` | 理由                                 |
| ----- | -------------------------------------------------- | ----------------- | ------------------------------------ |
| dev   | `{GOZD_DEV_PROJECT_ROOT}/apps/cli/src/index.ts`    | `bun`             | `.app` に CLI がバンドルされないため |
| build | `.app/Contents/Resources/app/bin/gozd`（絶対パス） | （空文字列）      | `.app` 内のバンドル済み CLI を使用   |

### ターミナル環境変数

| 変数              | 値               | 用途                           |
| ----------------- | ---------------- | ------------------------------ |
| `TERM`            | `xterm-256color` | ターミナル種別                 |
| `COLORTERM`       | `truecolor`      | 24bit カラー対応               |
| `TERM_PROGRAM`    | `gozd`           | アプリ識別                     |
| `FORCE_HYPERLINK` | `1`              | OSC 8 ハイパーリンク出力を許可 |

### ZDOTDIR 差し替えによる zsh 初期化チェーン

PTY 起動時に `ZDOTDIR` を gozd の `apps/desktop/zsh/` に差し替え、gozd の初期化ファイルがユーザーの初期化ファイルを透過的に `source` する。

```text
zsh 起動
  → gozd/.zshenv   → ユーザーの .zshenv を source → ZDOTDIR を gozd に戻す
  → gozd/.zprofile → ユーザーの .zprofile を source
  → gozd/.zshrc    → ユーザーの .zshrc を source → claude() 関数と OSC 7 通知を注入
  → gozd/.zlogin   → ユーザーの .zlogin を source → ZDOTDIR をユーザー側に固定
```

注入される関数:

- **`claude()`**: `claude` コマンドに `--settings $GOZD_CLAUDE_SETTINGS_PATH` を自動付与。ユーザーが明示的に `--settings` を指定した場合はそのまま通す
- **`_gozd_osc7_cwd()`**: ディレクトリ変更時に OSC 7 エスケープシーケンスを送信。xterm.js 側でパース

## データ永続化

アプリの状態と設定は `~/.config/gozd/` に JSON ファイルで保存する。ファイル I/O は常に desktop（Bun）側で行い、renderer からは RPC request 経由でアクセスする。

```text
~/.config/gozd/
├── app-state.json                        # グローバル: ウィンドウ状態（位置・サイズ・プロジェクト）
├── config.json                           # グローバル: ユーザー設定（VOICEVOX 等）
└── projects/
    └── <encodeURIComponent(projectDir)>/
        └── todos.json                    # プロジェクト固有: Todo 一覧
```

### スコープの使い分け

| スコープ       | 保存先                            | 例                               |
| -------------- | --------------------------------- | -------------------------------- |
| グローバル     | `~/.config/gozd/` 直下            | ウィンドウフレーム、ユーザー設定 |
| プロジェクト別 | `~/.config/gozd/projects/<path>/` | Todo、worktree スクリプト        |

### 新しい永続化データを追加するパターン

- `packages/rpc/` に request のスキーマ（params / response）を定義する
- `apps/desktop/src/` にファイル I/O モジュールを作成する（`appState.ts`, `todo.ts` が参考実装）
- `apps/desktop/src/index.ts` の RPC handlers に request ハンドラーを登録する
- renderer 側から `request.<name>()` で呼び出す

### 保存タイミング

| データ       | タイミング         | 実装                                       |
| ------------ | ------------------ | ------------------------------------------ |
| アプリ状態   | アプリ終了時の一括 | `before-quit` で `saveSnapshot()` 呼び出し |
| Todo         | 操作の都度即時保存 | `addTodo()` / `updateTodo()` 等で即 write  |
| ユーザー設定 | 操作の都度即時保存 | `saveConfig()` で read-modify-write        |

## Claude Code hooks

Claude Code の hooks 機能を使い、エージェントの状態変化をリアルタイムでフロントに通知する。

### 設定ファイルの生成

desktop 起動時に `generateClaudeSettings()` が hooks 設定 JSON を `$TMPDIR` に生成。`claude()` 関数が `--settings` で自動注入する。

### イベントと送信経路

| Claude hook          | gozd イベント | 送信経路    | 取得データ                         |
| -------------------- | ------------- | ----------- | ---------------------------------- |
| `UserPromptSubmit`   | `running`     | nc 直接送信 | `ptyId`                            |
| `Stop`               | `done`        | CLI 経由    | `ptyId`, `last_assistant_message`  |
| `PermissionRequest`  | `needs-input` | CLI 経由    | `ptyId`, `tool_name`, `tool_input` |
| `PostToolUse`        | `tool-done`   | nc 直接送信 | `ptyId`                            |
| `PostToolUseFailure` | `tool-done`   | nc 直接送信 | `ptyId`                            |

### 送信経路の使い分け

- **nc 直接送信**: `echo '固定JSON' | nc -w 1 -U $GOZD_SOCKET_PATH`。軽量だが stdin データを取得できない。発火頻度の高い running / tool-done に使用
- **CLI 経由**: `$GOZD_CLI_RUNNER "$GOZD_CLI_PATH" hook {event}`。CLI が stdin の JSON を `JSON.parse` して payload にマージするため、Claude Code が渡す詳細データ（応答テキスト、ツール情報）をフロントまで届けられる。done / needs-input に使用

### フロントへの到達経路

```text
Claude Code (hook 発火)
  → hook コマンド実行（nc or gozd CLI）
  → Unix ドメインソケット（HookMessage）
  → desktop handleSocketMessage()
  → RPC send.gozdHook()
  → renderer useTerminalStore handleHookEvent()
  → ClaudeStatus 更新 → サイドバーバッジ / 吹き出し表示
```
