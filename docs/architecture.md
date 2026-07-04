# アーキテクチャ

アプリの起動から通信までの全体像。各レイヤーがどう繋がるかを把握するためのドキュメント。

## レイヤー構成

```text
┌─────────────────────────────────────────────────────┐
│  renderer (Vue)                                     │
│  apps/renderer/                                     │
│  Electron renderer process 内で動作するフロントエンド │
└────────────────┬────────────────────────────────────┘
                 │ contextBridge（window.__gozdElectronRpc）
                 │ ipcRenderer.invoke("rpc:request") / on("rpc:push")
┌────────────────┴────────────────────────────────────┐
│  main (Electron / TypeScript)                       │
│  apps/electron/src/                                 │
│  PTY (node-pty), ファイル監視 (@parcel/watcher),     │
│  RPC ディスパッチ, ソケットサーバー, 永続化ストア      │
└────────────────┬────────────────────────────────────┘
                 │ Unix ドメインソケット（NDJSON / JSON 1 行 = 1 ClientMessage）
┌────────────────┴────────────────────────────────────┐
│  CLI (TypeScript)                                   │
│  apps/electron/src/cli.ts → dist/cli.cjs            │
│  + bin/gozd-cli shim + resources/bin/gozd ラッパー   │
└─────────────────────────────────────────────────────┘
```

renderer ↔ main は Electron の process 境界。preload（`src/preload.ts`）が contextBridge で
`window.__gozdElectronRpc`（request / onPush）を公開し、renderer の `shared/rpc` はこのブリッジの
有無でトランスポートを静的に選ぶ。ブリッジ契約 `ElectronRpcBridge` は `@gozd/shared` が SSOT。

## 型共有: `@gozd/rpc`

RPC 型は `packages/rpc` の手書き TS 型を SSOT に置き、renderer / electron が同じ定義を
import する（Swift 並走期の `.proto` SSOT + ts-proto 生成は廃止済み。issue #895）。

- ワイヤは素の JSON。両端が同型を参照するため codec は存在せず、renderer は
  `JSON.stringify` / `JSON.parse`、main は `body as X` cast + `satisfies X` で型を通す
- フィールド名 = JSON キー（旧 proto3 JSON mapping の lowerCamelCase を踏襲）。
  `?` フィールドはキー不在で未設定を表現する
- 旧 enum は文字列リテラル union（main 内部表現と同一文字列。境界の変換層なし）。
  例外は tasks.json に永続化される `GhRefKind`（[rpc.md](rpc.md) 参照）
- プロセス境界を跨ぐ「信頼できない入力」（永続ファイル / socket NDJSON）だけは受信側で
  default 充填の正規化を通す（`apps/electron/src/rawJson.ts` の契約）

## ビルドと `.app` の構造

- `pnpm dev` — renderer（Vite HMR）と Electron shell（esbuild → `electron .`）を concurrently で
  同時起動。`GOZD_DEV_VITE_PORT`（root の dev script が設定）が Vite URL の SSOT で、
  Electron main が `http://localhost:{port}` を導出して loadURL する。esbuild + electron の
  起動は Vite より速いため、初回 load の ERR_CONNECTION_REFUSED は did-fail-load で retry する
- `pnpm --filter @gozd/electron build:app` — electron-builder（`electron-builder.yml`、YAML のみ）で
  `out/mac-arm64/Gozd.app` を生成。renderer は `.app` 同梱の Vite build 成果物を `loadFile` で読む
  （Vite build は `base: "./"` の相対パスなので file:// で成立する）

### electron-builder の前提

- workspace は `nodeLinker: hoisted`（pnpm-workspace.yaml）。Electron 公式処方
  「パッケージングツールチェーンは npm 式に物理配置された node_modules を前提とする」に従う。
  これにより electron-builder 標準の prod 依存収集（node-pty / @parcel/watcher + transitive）が
  そのまま機能する
- `asar: false`。gozd-cli は `ELECTRON_RUN_AS_NODE` 起動で asar 内の依存が require から見えず、
  asar を使うと unpack 列挙が必要になるため丸ごと回避する（bin/ zsh/ も素のファイルで持つ）
- `electronDist` は指定しない（electron-builder 標準の zip ダウンロード + 展開）。unpacked dist を
  渡すとコピー経路が Electron.app 最上位の空 `.lproj`（macOS のアプリ言語判定に使われる）を
  落とし、renderer の Intl ロケールが en-US に固定される
- bundle id は `io.github.miyaoka.gozd.electron`

### `.app` 内の配置

```text
Gozd.app/Contents/
├── MacOS/Gozd                       # Electron メインバイナリ
└── Resources/
    ├── icon.icns
    └── app/
        ├── package.json / dist/     # esbuild 成果物（main / preload / cli）
        ├── node_modules/            # prod 依存（electron-builder が収集）
        ├── views/main/              # renderer の Vite ビルド成果物
        ├── bin/gozd                 # シェルラッパー
        ├── bin/gozd-cli             # CLI shim（ELECTRON_RUN_AS_NODE で dist/cli.cjs を実行）
        └── zsh/                     # gozd zsh init チェーン
```

### `bin/gozd` シェルラッパーの動作

`apps/electron/resources/bin/gozd` は bash スクリプト。

- **cold start**（アプリ未起動）: CLI が launch request ファイルを `$TMPDIR/gozd-{channel}-launch/` に
  書き出し → `open` で `.app` を起動 → アプリが起動時に最古の 1 件を consume して renderer に push
  （読み取り失敗でも対象ファイルは削除する。壊れた request の残留は起動のたびに失敗し続けるため）
- **warm start**（アプリ起動済み）: CLI がソケット経由で `OpenMessage` を送信 → renderer に push
- **hook コマンド**: アプリ起動チェックをスキップし、CLI を直接実行

### gozd-cli（TS 実装）

`src/cli.ts` を esbuild で `dist/cli.cjs` に全依存 bundle する。実行 shim は 2 種:

- dev: `apps/electron/bin/gozd-cli`（node で実行）
- packaged: `resources/bin/gozd-cli`（`ELECTRON_RUN_AS_NODE=1` + 同梱 Electron バイナリ。
  ユーザー環境に Node を要求しない）

ワイヤは NDJSON 1 行の `ClientMessage` JSON。launch dir の channel は
`GOZD_SOCKET_PATH` のファイル名（`gozd-<channel>.sock`）から導出するため socket と自動で揃う。

### channel によるリソース分離

socket / launch dir / claude settings は channel で分離する。packaged `.app` は `stable`、
未パッケージ（`electron .`）は `dev`。判定は `gozdEnv.isPackaged`
（`__dirname` が `process.resourcesPath` 配下かどうか）。

| リソース          | パス                                          |
| ----------------- | --------------------------------------------- |
| ソケット          | `$TMPDIR/gozd-{channel}.sock`                 |
| launch request    | `$TMPDIR/gozd-{channel}-launch/`              |
| Claude hooks 設定 | `$TMPDIR/gozd-{channel}-claude-settings.json` |

永続データ（`~/.config/gozd/` 配下）は dev / stable で **共有** する。

## 外部リンクの navigation 防壁

renderer 内の `<a target="_blank">` / `window.open` / main frame の外部 http(s) 遷移は、
デフォルトでは新しい Electron window を開くか UI 全体を置換してしまう。
`installExternalLinkPolicy`（`src/main.ts`）が構造的な防壁を張る:

- `setWindowOpenHandler`: 全経路 deny。http(s) のみ `shell.openExternal` で OS ブラウザへ
- `will-navigate`: 内部 origin（dev の Vite URL / packaged の file:）は許可、外部 http(s) は
  preventDefault + OS ブラウザへ、その他 scheme は許可

判定軸は scheme 3 分岐で、`<a href>` 以外の経路（form submit / window.open 等）でも外部送りで揃える。
launch 失敗は具体的な error 込みで stderr に残す（silent drop 禁止）。

markdown preview で render される `[text](https://...)` 由来のリンクも同じ防壁を通るため、
すべて外部ブラウザで開かれる。

## 通信経路

### IPC（renderer ↔ main）

- **request**（応答あり）: renderer → main。`ipcRenderer.invoke("rpc:request", path, bodyJson)` →
  `rpcDispatcher.ts` のルート表 → 実装は `routes.ts`。ワイヤは `@gozd/rpc` 型の JSON
- **push**（一方向）: main → renderer。`webContents.send("rpc:push", type, payload)` →
  preload 経由で renderer の `initRpcDispatcher` が購読

renderer の購読登録（module 実行）は `did-finish-load` 前に完了するため、load 完了後の push は
落ちない。renderer 再構築中（Vite フルリロード等）に落ちた push は、mount 時の pull hydrate +
onMessage 購読の貼り直しで構造的に回復する（Swift 期から続く規律。落としてはいけない push は
「1 度の取りこぼしで UI 状態が永続的にずれる」もので、それらには観察ログを残す）。

詳細なメッセージ一覧は [rpc.md](rpc.md)。

### gozd-file:// protocol（preview の `<img>` 配信）

preview ペインの image / SVG 表示専用。`protocol.handle("gozd-file", ...)`（`src/fileServer.ts`）が
raw bytes を返す。JSON ワイヤの `content: string` はバイナリを保持できない（base64 の膨張と
往復コストも無駄）ため、`<img>` 経路だけ別 scheme に分けている。

- `/fs` : 作業ツリーの実ファイル（`resolveSafe` containment + `validateRelPath`）
- `/git`: `git show HEAD:<path>` の出力
- `/abs`: 絶対パス単独（worktree 外の画像 / SVG 用。dir 制約なし）

セキュリティ規律: `Access-Control-Allow-Origin` は意図して付けない。`<img>` は passive content
として CORS check 対象外で表示でき、cross-origin の `fetch()` / `canvas.getImageData()` は CORS で
構造的にブロックされる。「画像は見える、bytes は機械的に取れない」の両立。`/abs` が worktree 外を
読める防御境界はこの規律に依存する。

### SSOT push の dir filter 規律

ファイル監視経由の push は ms オーダーで届くが、watch 開始往復中の取りこぼしや配送失敗で
1 度の event を落とすと、UI 状態と git refs の実体が永続的にずれる。これを防ぐため、
全 push に source `dir` を載せ、購読側が自分の責務に応じて filter する契約を統一する。

- **payload に dir を載せる**: `gitStatusChange` / `branchChange` / `remoteRefsChange` /
  `worktreeChange` / `fsWatchReady` すべての push payload は `dir` を必須フィールドとして持つ。
  dir を載せないと N watch × M subscriber の cross product 発火が避けられず、累積発火が
  外部リソース（GitHub rate limit 等）を食い潰す
- **再同期トリガー**: `useFsWatchSync` が `rpcFsWatch` 成功ごとに renderer 内部で `fsWatchReady` を
  **dir 1 件につき 1 push** 発射する。GitGraphPane は active と同 repo の event だけ `loadLog`、
  useSidebarData は source dir の所有 repo を再 fetch する
- **active filter / source-dir filter の使い分け**: pane の責務 + event の種類で filter 方向を変える
  - GitGraphPane: `gitStatusChange` は per-worktree なので strict dir match、
    `branchChange` / `remoteRefsChange` / `fsWatchReady` は同 repo 判定で受ける
  - useSidebarData: `findRepoOwning(dir).rootDir` を fetch
- **status payload に branch.head を含める**: `git branch -m` は HEAD の commit OID を変えないため、
  `gitStatusChange.head` だけで判定すると rename を取りこぼす。renderer は `branchHead` の変化でも
  `loadLog` を発火する

> [!NOTE]
> PR list は push 経路で原理的に到達不能（`gh pr create` 等の local refs を動かさない GitHub
> mutation）のため、active worktree 1 個に scope を絞った 60 秒間隔の `gh pr list` polling を
> GitGraphPane 内に持つ。詳細は [git.md](git.md)。

### FSWatch の対象スコープ

`useFsWatchSync` は **開いている全 repo / 全 worktree の dir** を `rpcFsWatch` に登録する。
watch 対象の集合は `useRepoStore` の computed `fsWatchTargetDirs` として store 側で派生する。

- gozd は「window 内マルチ repo + マルチ worktree」が機能要件なので、active 1 dir だけの watch では
  別 repo / 別 worktree の commit / rename / push を取りこぼす
- per-worktree git dir 配下の `HEAD` / `index` 変化も worktree ごとに独立して watch される
- 非 git project は rootDir そのものを watch（fsChange のみが意味を持つ）
- `rpcFsWatch` / `rpcFsUnwatch` は main 側 `fsWatchRegistry` で idempotent
- @parcel/watcher は 1 subscribe = 1 root で、包含 root を重ねると同一 event が二重配送される。
  `fsWatchRegistry` は最小被覆集合だけ subscribe する

### Unix ドメインソケット（CLI / Claude hooks → main）

`socketServer.ts` が `$TMPDIR/gozd-{channel}.sock` で待ち受ける。プロトコルは NDJSON
（改行区切り JSON）。1 行が `ClientMessage`（`@gozd/rpc`。`open` / `hook` の
どちらか一方だけを設定する）。

- `OpenMessage`: `gozd open <path>` 相当。renderer に gozdOpen を push
- `HookMessage`: Claude Code hooks からの状態通知。renderer に hook を push

処理は promise chain の逐次キュー（`socketMessages.ts`）で、同 ptyId の session 系 hook が
submit 順に処理されることを保証する。

## PTY と環境変数

main が PTY を spawn する時に以下の環境変数を注入する（`gozdEnv.buildPtyEnv`。
親 env 全継承 + deny-list + gozd overlay の 3 層 merge）。

> [!WARNING]
> `PtySpawnRequest.args` のワイヤ契約は **argv 全体**（args[0] = プログラム名）。node-pty は
> args に argv[0] を含めない流儀なので、main 側で `args.slice(1)` して渡す。

### gozd 固有の環境変数

| 変数                        | 用途                                                     |
| --------------------------- | -------------------------------------------------------- |
| `GOZD_PTY_ID`               | PTY の識別子。hooks イベントの発火元を特定する           |
| `GOZD_SOCKET_PATH`          | ソケットパス。CLI や hooks コマンドが接続先に使う        |
| `GOZD_CLI_PATH`             | `gozd-cli` shim の絶対パス。dev と packaged で値が異なる |
| `GOZD_CLAUDE_SETTINGS_PATH` | Claude hooks 設定ファイルのパス。`claude()` 関数が参照   |
| `GOZD_ZDOTDIR`              | gozd の zsh 初期化ディレクトリ                           |
| `GOZD_ORIG_ZDOTDIR`         | ユーザーの元の ZDOTDIR（gozd が上書きする前の値）        |

`GOZD_CLI_PATH` は dev では `apps/electron/bin/gozd-cli`、packaged では
`.app/Contents/Resources/app/bin/gozd-cli` に解決される（`gozdEnv.ts`）。

### ターミナル環境変数

| 変数              | 値               | 用途                           |
| ----------------- | ---------------- | ------------------------------ |
| `TERM`            | `xterm-256color` | ターミナル種別                 |
| `COLORTERM`       | `truecolor`      | 24bit カラー対応               |
| `TERM_PROGRAM`    | `gozd`           | アプリ識別                     |
| `FORCE_HYPERLINK` | `1`              | OSC 8 ハイパーリンク出力を許可 |

### ZDOTDIR 差し替えによる zsh 初期化チェーン

PTY 起動時に `ZDOTDIR` を gozd の zsh 初期化ディレクトリ（dev: `apps/electron/resources/zsh/`、
packaged: `.app/Contents/Resources/app/zsh/`）に差し替え、gozd の初期化ファイルがユーザーの
初期化ファイルを透過的に `source` する。

```text
zsh 起動
  → gozd/.zshenv   → ユーザーの .zshenv を source → ZDOTDIR を gozd に戻す
  → gozd/.zprofile → ユーザーの .zprofile を source
  → gozd/.zshrc    → ユーザーの .zshrc を source → claude() 関数と OSC 7 通知を注入
  → gozd/.zlogin   → ユーザーの .zlogin を source → ZDOTDIR をユーザー側に固定
```

注入される関数:

- **`claude()`**: `claude` コマンドに `--settings $GOZD_CLAUDE_SETTINGS_PATH` を自動付与。
  ユーザーが明示的に `--settings` を指定した場合はそのまま通す
- **`_gozd_osc7_cwd()`**: ディレクトリ変更時に OSC 7 エスケープシーケンスを送信。xterm.js 側でパース

## データ永続化

アプリのデータは XDG の役割で 2 ディレクトリに分ける。ユーザー設定 (config) / プロジェクトデータは
`~/.config/gozd/`、「前回の続き」を表す state（sidebar 並び順・折りたたみ / worktree 一覧キャッシュ）は
`~/.local/state/gozd/` に JSON で保存する。どちらも dev / stable で共有する。
ファイル I/O は常に main 側で行い、renderer からは RPC request 経由でアクセスする。

> [!WARNING]
> 永続ファイルへの cross-process ロックは未実装。dev / stable を同時起動した場合、各ストアの
> `load → mutate → save` が並走すると、最後に save したプロセスが他方の変更を上書きする可能性がある。

```text
~/.local/state/gozd/
├── app-state.json                        # state: sidebar repo 並び順 / 折りたたみ / worktree 一覧キャッシュ
└── electron-window.json                  # state: window frame（shell 固有。close 時に保存）

~/.config/gozd/
├── config.json                           # グローバル: ユーザー設定（VOICEVOX 等）
└── projects/
    └── <projectKey>/                     # <repoName>-<hash>（realpath の SHA-256 先頭12文字）
        ├── tasks.json                    # プロジェクト固有: Task 一覧（Claude session_id を task.session_id に持つ）
        └── config.json                   # プロジェクト固有: worktreeSymlinks 等
```

Claude セッションの sessionId は専用ストアを持たず `tasks.json` の `task.session_id` を SSOT とする
（[workspace.md](workspace.md)）。

- 保存は全フィールドを明示的に書く。旧 proto3 JSON は default 値のフィールドを省略して
  書いたため、既存ファイルの欠落キーは各 store の load 時に default 充填する
  （`rawJson.ts` の契約。「フィールド不在 = default 値」の永続ファイル契約を維持）
- `AppState` の save は既存ファイルを raw dict として読み shallow merge して未知 top-level キー
  （別バージョンが書いたフィールド）を保持する
- `TaskStore`（`tasks.json`）の load は parse 失敗時に**空 list で上書き save** する
  （後方互換を作らない規約。主データを JOIN する立場のため load 経路から throw を伝播させない）。
  stderr に reinit ログを残して観察可能性を保つ

### 新しい永続化データを追加するパターン

- `packages/rpc/src/` に schema 型（request / response / 永続化形式）を追加し、
  `index.ts` barrel から export する
- `apps/electron/src/` にファイル I/O モジュールを作成する（`stores.ts` / `taskStore.ts` が
  参考実装。load 経路は `rawJson.ts` で default 充填する）
- `apps/electron/src/routes.ts` に handler を登録する
- renderer 側は feature ごとの `rpc.ts` に `rpcXxx()` 関数を追加し、`shared/rpc` の
  `rpc<Response>(path, req)` でラップする

### 保存タイミング

| データ       | タイミング         | 実装                                        |
| ------------ | ------------------ | ------------------------------------------- |
| アプリ状態   | アプリ終了時の一括 | renderer が保存 RPC を発行                  |
| window frame | window close 時    | `close` イベントで `getNormalBounds` を保存 |
| Task         | 操作の都度即時保存 | `addTask()` / `updateTask()` 等で即 write   |
| ユーザー設定 | 操作の都度即時保存 | `saveConfig()` で read-modify-write         |

## Claude Code hooks

Claude Code の hooks 機能を使い、エージェントの状態変化をリアルタイムでフロントに通知する。

### 設定ファイルの生成

アプリ起動時に `claudeHooksSettings.ts` が hooks 設定 JSON を `$TMPDIR` に生成。
zsh init の `claude()` 関数が `--settings` で自動注入する。

### イベントと送信経路

| Claude hook          | gozd イベント   | 送信経路    | 取得データ                         |
| -------------------- | --------------- | ----------- | ---------------------------------- |
| `SessionStart`       | `session-start` | CLI 経由    | `ptyId`, `session_id`, `source`    |
| `SessionEnd`         | `session-end`   | CLI 経由    | `ptyId`, `session_id`              |
| `UserPromptSubmit`   | `running`       | nc 直接送信 | `ptyId`                            |
| `Stop`               | `done`          | CLI 経由    | `ptyId`, `last_assistant_message`  |
| `PermissionRequest`  | `needs-input`   | CLI 経由    | `ptyId`, `tool_name`, `tool_input` |
| `PostToolUse`        | `tool-done`     | nc 直接送信 | `ptyId`                            |
| `PostToolUseFailure` | `tool-failure`  | CLI 経由    | `ptyId`, `is_interrupt`            |
| `StopFailure`        | `stop-failure`  | CLI 経由    | `ptyId`, `last_assistant_message`  |

### 送信経路の使い分け

- **nc 直接送信**: `echo '固定JSON' | nc -w 1 -U $GOZD_SOCKET_PATH`。軽量だが stdin データを
  取得できない。発火頻度の高い running / tool-done に使用
- **CLI 経由**: `"$GOZD_CLI_PATH" hook {event}`。CLI が stdin の JSON を parse して payload に
  マージするため、Claude Code が渡す詳細データをフロントまで届けられる

### フロントへの到達経路

```text
Claude Code (hook 発火)
  → hook コマンド実行（nc or gozd-cli）
  → Unix ドメインソケット（HookMessage を含む ClientMessage の JSON）
  → socketServer → socketMessages（逐次キュー）
  → webContents.send("rpc:push", "hook", payload)
  → renderer useTerminalStore handleHookEvent()
  → ClaudeStatus 更新 → サイドバーバッジ / 吹き出し表示
```
