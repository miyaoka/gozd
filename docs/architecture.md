# アーキテクチャ

アプリの起動から通信までの全体像。各レイヤーがどう繋がるかを把握するためのドキュメント。

## レイヤー構成

```text
┌─────────────────────────────────────────────────────┐
│  renderer (Vue)                                     │
│  apps/renderer/                                     │
│  WebKit（WebPage）内で動作するフロントエンド          │
└────────────────┬────────────────────────────────────┘
                 │ gozd-rpc:// URLSchemeHandler（request/response）
                 │ window.__gozdReceive(...)（push）
┌────────────────┴────────────────────────────────────┐
│  native (Swift / SwiftUI)                           │
│  apps/native/Sources/Gozd, GozdCore                 │
│  メインアプリ。PTY, FSEvents, RPC ディスパッチ,       │
│  ソケットサーバー, 永続化ストア                       │
└────────────────┬────────────────────────────────────┘
                 │ Unix ドメインソケット（NDJSON / proto3 JSON）
┌────────────────┴────────────────────────────────────┐
│  CLI (Swift)                                        │
│  apps/native/Sources/GozdCLI → gozd-cli バイナリ     │
│  + Resources/bin/gozd（シェルラッパー）               │
└─────────────────────────────────────────────────────┘
```

renderer は単体プロセスではなく、Swift メインアプリの中の `WebPage`（macOS 26 で追加された SwiftUI WebKit 統合）に Vue バンドルをロードして動かす。renderer ↔ native は別プロセスではないが、URLSchemeHandler 越しに request/response を通すことでメッセージ境界を強制している。

## 型共有: `.proto` SSOT

TS（renderer）と Swift（native）で RPC 型を共有するため、`packages/proto/` の `.proto` を SSOT に置き、buf で両言語のコードを生成する。

- ts-proto → `packages/proto-ts/src/generated/`（`@gozd/proto` として renderer が import）
- swift-protobuf → `packages/proto-swift/Sources/GozdProto/`（`GozdProto` を native が import）

生成物は git に commit する。`buf.gen.yaml` では BSR のリモートプラグイン (`buf.build/community/stephenh-ts-proto` / `buf.build/apple/swift`) をバージョン pin して指定する。

トランスポートは Connect / gRPC を使わず、`gozd-rpc://` URLSchemeHandler + Unix Socket（NDJSON）で自前実装する。Protobuf の `oneof` を discriminated union として使うのが目的。

## ビルドと `.app` の構造

`pnpm dev` / `pnpm build` どちらでも `.app` バンドルを構築する。Swift メインバイナリと renderer の Vite ビルド成果物を `.app/Contents/Resources/app/` 配下にまとめる。

### `.app` 内の配置（`apps/native/scripts/build-app.sh`）

```text
Gozd.app/Contents/
├── MacOS/Gozd                       # Swift メインアプリバイナリ
└── Resources/
    ├── AppIcon.icns
    └── app/
        ├── views/main/              # renderer の Vite ビルド成果物
        ├── bin/gozd                 # シェルラッパー
        ├── bin/gozd-cli             # Swift CLI バイナリ
        └── zsh/                     # gozd zsh init チェーン
```

`pnpm dev` は `apps/native/scripts/build-dev-app.sh` で **dev 専用 `.app`**（dock icon が dev カラー、タイトルが `gozd (dev)`）を生成し、renderer は Vite dev server（`http://localhost:5173`、`GOZD_DEV_VITE_URL` で指定）から読み込む。`pnpm build` は `build-app.sh` で stable 版 `.app` を生成し、renderer はバンドル内 `views/main/index.html` を `gozd-app://` URLSchemeHandler 経由でロードする。

> [!NOTE]
> `WebPage` には `loadFileURL(_:allowingReadAccessTo:)` 相当が無いため、ローカル HTML / asset は `gozd-app://localhost/...` URLSchemeHandler で配信する（WWDC25「Meet WebKit for SwiftUI」公式パターン）。`gozd-app://` の resolver は `.standardized` + `resolvingSymlinksInPath` した実体パスが bundle root 配下にあることを検証して path traversal を防ぐ。

### `bin/gozd` シェルラッパーの動作

`apps/native/Resources/bin/gozd` は bash スクリプト。`.app` 内 `Contents/Resources/app/bin/gozd-cli`（Swift CLI バイナリ）を呼び出す。

- **cold start**（アプリ未起動）: CLI が launch request ファイルを `$TMPDIR/gozd-{channel}-launch/` に書き出し → `open` で `.app` を起動 → アプリが起動時に request を読み取って renderer に push
- **warm start**（アプリ起動済み）: CLI がソケット経由で `OpenMessage` を送信 → `SocketServer` が renderer に push
- **hook コマンド**: アプリ起動チェックをスキップし、CLI を直接実行

## 起動フロー

### `pnpm dev`（開発時）

- ルートの `pnpm dev` が `concurrently` で renderer（Vite HMR）と native（Swift dev `.app`）を同時起動
- native の dev スクリプトは `GOZD_DEV_PROJECT_ROOT=$(repo root)` `GOZD_DEV_VITE_URL=http://localhost:5173` を渡して `apps/native/scripts/build-dev-app.sh` を実行する
- `GOZD_DEV_PROJECT_ROOT` は dev 時のみ存在し、リポジトリルートを指す。dev / stable の判別、CLI パスや zsh init の解決に使用する（初期 open の指示には使わない。worktree から `pnpm dev` するたびに toplevel が変わるため）

### `pnpm build` → `.app` 起動（本番）

- `pnpm -r build` で全パッケージをビルド（renderer の `dist/` も生成される）
- `pnpm --filter @gozd/native build` が `swift build -c release` 後 `build-app.sh` で `.app` を組み立てる
- 起動方法: Dock / Finder から直接、または `gozd <path>` CLI 経由

### channel によるリソース分離

socket / launch dir / claude settings は `GOZD_DEV_PROJECT_ROOT` の有無で `dev` / `stable` を判別して分離する。dev と stable が同時に動いても衝突しない。

| リソース          | パス                                          |
| ----------------- | --------------------------------------------- |
| ソケット          | `$TMPDIR/gozd-{channel}.sock`                 |
| launch request    | `$TMPDIR/gozd-{channel}-launch/`              |
| Claude hooks 設定 | `$TMPDIR/gozd-{channel}-claude-settings.json` |

永続データ（`~/.config/gozd/` 配下）は dev / stable で **共有** する。worktree 本体（`~/.local/share/gozd/worktrees/`）が共有なのと同じ扱い。

## 通信経路

### gozd-rpc:// URLSchemeHandler（renderer ↔ native）

renderer は `fetch("gozd-rpc://localhost/{path}", { method, body })` で RPC を呼ぶ。`RpcSchemeHandler`（`apps/native/Sources/Gozd/GozdApp.swift`）が HTTP 風のレスポンスにラップして返す。実際のロジックは `RpcDispatcher`。

native → renderer の push は `WebPage.callJavaScript("window.__gozdReceive(type, payload)", ...)` で行う。

- **request**（応答あり）: `renderer → native`。ptySpawn, fsReadFile, gitStatus 等
- **push**（一方向）: `native → renderer`。ptyText, hook, fsChange, gitStatusChange 等

詳細なメッセージ一覧は [rpc.md](rpc.md)。

### Unix ドメインソケット（CLI / Claude hooks → native）

`SocketServer`（`apps/native/Sources/GozdCore/SocketServer.swift`）が `$TMPDIR/gozd-{channel}.sock` で待ち受ける。プロトコルは NDJSON（改行区切り JSON）。1 行が proto3 JSON でエンコードされた `ClientMessage`（`oneof` で `OpenMessage` / `HookMessage` を切り替え）。

- `OpenMessage`: `gozd open <path>` 相当。renderer に gozdOpen を push
- `HookMessage`: Claude Code hooks からの状態通知。renderer に hook を push

CLI 側は `swift-protobuf` で同じ型を share している。

## PTY と環境変数

native が PTY を spawn する時に以下の環境変数を注入する（`PTYManager` + `GozdEnvOverlay`）。

### gozd 固有の環境変数

| 変数                        | 用途                                                     |
| --------------------------- | -------------------------------------------------------- |
| `GOZD_PTY_ID`               | PTY の識別子。hooks イベントの発火元を特定する           |
| `GOZD_SOCKET_PATH`          | ソケットパス。CLI や hooks コマンドが接続先に使う        |
| `GOZD_CLI_PATH`             | `gozd-cli` バイナリの絶対パス。dev と build で値が異なる |
| `GOZD_CLAUDE_SETTINGS_PATH` | Claude hooks 設定ファイルのパス。`claude()` 関数が参照   |
| `GOZD_ZDOTDIR`              | gozd の zsh 初期化ディレクトリ                           |
| `GOZD_ORIG_ZDOTDIR`         | ユーザーの元の ZDOTDIR（gozd が上書きする前の値）        |

#### `GOZD_CLI_PATH` の解決

| 環境  | `GOZD_CLI_PATH`                                             | 理由                               |
| ----- | ----------------------------------------------------------- | ---------------------------------- |
| dev   | `{GOZD_DEV_PROJECT_ROOT}/apps/native/.build/debug/gozd-cli` | dev `.app` には CLI を埋め込まない |
| build | `.app/Contents/Resources/app/bin/gozd-cli`（絶対パス）      | `.app` 内のバンドル済み CLI を使用 |

CLI はネイティブバイナリ。Bun runner のような言語ランタイム経由の起動は不要。

### ターミナル環境変数

| 変数              | 値               | 用途                           |
| ----------------- | ---------------- | ------------------------------ |
| `TERM`            | `xterm-256color` | ターミナル種別                 |
| `COLORTERM`       | `truecolor`      | 24bit カラー対応               |
| `TERM_PROGRAM`    | `gozd`           | アプリ識別                     |
| `FORCE_HYPERLINK` | `1`              | OSC 8 ハイパーリンク出力を許可 |

### ZDOTDIR 差し替えによる zsh 初期化チェーン

PTY 起動時に `ZDOTDIR` を gozd の zsh 初期化ディレクトリに差し替え、gozd の初期化ファイルがユーザーの初期化ファイルを透過的に `source` する。dev では `apps/native/Resources/zsh/`、build では `.app/Contents/Resources/app/zsh/` を指す。

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

アプリの状態と設定は `~/.config/gozd/` に proto3 JSON で保存する。dev / stable で永続ディレクトリは共有する。channel で分離するのは衝突回避が必要な実行時リソース（socket / TMPDIR / Vite URL / CLI ソース参照先）のみ。ファイル I/O は常に native（Swift）側で行い、renderer からは RPC request 経由でアクセスする。

> [!WARNING]
> 永続ファイルへの cross-process ロックは未実装。dev / stable を同時起動した場合、各ストア（`AppStateStore` / `AppConfigStore` / `TaskStore` / `ProjectConfigStore`）の `load → mutate → save` が並走すると、最後に save したプロセスが他方の変更を上書きする可能性がある。

```text
~/.config/gozd/
├── app-state.json                        # グローバル: ウィンドウ状態 / repo 並び順 / 折りたたみ状態
├── config.json                           # グローバル: ユーザー設定（VOICEVOX 等）
└── projects/
    └── <projectKey>/                     # <repoName>-<hash>（realpath の SHA-256 先頭12文字）
        ├── tasks.json                    # プロジェクト固有: Task 一覧
        └── config.json                   # プロジェクト固有: worktreeSymlinks 等
```

`AppStateStore` / `AppConfigStore` / `ProjectConfigStore` の load は `JSONDecodingOptions.ignoreUnknownFields = true` を有効にして forward/backward compat を確保する。save は raw dict と shallow merge して未知の top-level キーを落とさない。

### スコープの使い分け

| スコープ       | 保存先                                  | 例                                            |
| -------------- | --------------------------------------- | --------------------------------------------- |
| グローバル     | `~/.config/gozd/` 直下                  | ウィンドウフレーム、repo 並び順、ユーザー設定 |
| プロジェクト別 | `~/.config/gozd/projects/<projectKey>/` | Task、worktree スクリプト                     |

### 新しい永続化データを追加するパターン

- `packages/proto/gozd/v1/*.proto` に request スキーマ（params / response）を追加し、`buf generate` で TS / Swift 生成物を更新する
- `apps/native/Sources/GozdCore/` にファイル I/O モジュールを作成する（`AppStateStore.swift`, `TaskStore.swift` が参考実装）
- `apps/native/Sources/GozdCore/RpcDispatcher.swift` の handler に request 処理を登録する
- renderer 側は feature ごとの `rpc.ts` に `rpcXxx()` 関数を追加し、`shared/rpc` の `rpc(path, req, RequestType, ResponseType)` でラップする（例: `apps/renderer/src/features/filer/rpc.ts` の `rpcFsReadDir`）

### 保存タイミング

| データ       | タイミング         | 実装                                        |
| ------------ | ------------------ | ------------------------------------------- |
| アプリ状態   | アプリ終了時の一括 | `applicationWillTerminate` で save 呼び出し |
| Task         | 操作の都度即時保存 | `addTask()` / `updateTask()` 等で即 write   |
| ユーザー設定 | 操作の都度即時保存 | `saveConfig()` で read-modify-write         |

## Claude Code hooks

Claude Code の hooks 機能を使い、エージェントの状態変化をリアルタイムでフロントに通知する。

### 設定ファイルの生成

native 起動時に `ClaudeHooksSettings.write(to:)` が hooks 設定 JSON を `$TMPDIR` に生成。`claude()` 関数が `--settings` で自動注入する。

### イベントと送信経路

| Claude hook          | gozd イベント   | 送信経路    | 取得データ                         |
| -------------------- | --------------- | ----------- | ---------------------------------- |
| `SessionStart`       | `session-start` | nc 直接送信 | `ptyId`                            |
| `SessionEnd`         | `session-end`   | nc 直接送信 | `ptyId`                            |
| `UserPromptSubmit`   | `running`       | nc 直接送信 | `ptyId`                            |
| `Stop`               | `done`          | CLI 経由    | `ptyId`, `last_assistant_message`  |
| `PermissionRequest`  | `needs-input`   | CLI 経由    | `ptyId`, `tool_name`, `tool_input` |
| `PostToolUse`        | `tool-done`     | nc 直接送信 | `ptyId`                            |
| `PostToolUseFailure` | `tool-failure`  | CLI 経由    | `ptyId`, `is_interrupt`            |
| `StopFailure`        | `stop-failure`  | CLI 経由    | `ptyId`, `last_assistant_message`  |

### 送信経路の使い分け

- **nc 直接送信**: `echo '固定JSON' | nc -w 1 -U $GOZD_SOCKET_PATH`。軽量だが stdin データを取得できない。発火頻度の高い running / tool-done に使用
- **CLI 経由**: `"$GOZD_CLI_PATH" hook {event}`。CLI が stdin の JSON を `JSON.parse` して payload にマージするため、Claude Code が渡す詳細データ（応答テキスト、ツール情報）をフロントまで届けられる。done / needs-input に使用

### フロントへの到達経路

```text
Claude Code (hook 発火)
  → hook コマンド実行（nc or gozd-cli）
  → Unix ドメインソケット（HookMessage、proto3 JSON）
  → SocketServer → RpcDispatcher.handleSocketMessage()
  → WebPage.callJavaScript("window.__gozdReceive('hook', payload)")
  → renderer useTerminalStore handleHookEvent()
  → ClaudeStatus 更新 → サイドバーバッジ / 吹き出し表示
```
