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

- renderer ↔ main のワイヤは Electron IPC の structured clone。両端が同型を参照するため
  codec は存在せず、plain data（JSON 形 + `WireBytes`）をそのまま運ぶ。main は
  `body as X` cast + `satisfies X` で型を通す。Vue の reactive proxy 等の exotic object は
  clone できず reject するため、呼び出し側が plain data を渡す（不変条件の SSOT は
  `@gozd/shared` の `ElectronRpcBridge` docstring）
- バイナリ（ファイル内容等）は `WireBytes` を第一級で運ぶ。main の Buffer は送出前に
  exact-size コピー（`toWireBytes`）へ変換する（Buffer の共有プール view をそのまま送ると
  backing ArrayBuffer ごと複製され、無関係なデータが漏出するため）。CLI / hooks の
  Unix ソケットは従来どおり NDJSON で、socket を通る型にバイナリは載せない
- フィールド名は旧 proto3 JSON mapping の lowerCamelCase を踏襲（永続化 JSON のキーと一致）。
  `?` フィールドは undefined（永続化 JSON ではキー不在）で未設定を表現する
- 旧 enum は文字列リテラル union（main 内部表現と同一文字列。境界の変換層なし）。
  例外は tasks.json に永続化される `GhRefKind`（[rpc.md](rpc.md) 参照）
- プロセス境界を跨ぐ「信頼できない入力」（永続ファイル / socket NDJSON）だけは受信側で
  default 充填の正規化を通す（`apps/electron/src/rawJson.ts` の契約）

## ビルドと `.app` の構造

- `pnpm dev` — renderer（Vite HMR）と Electron shell（esbuild → `electron .`）を concurrently で
  同時起動。`GOZD_DEV_VITE_PORT`（root の dev runner `scripts/dev.ts` が worktree の realpath から
  決定論的に導出して設定）が Vite URL の SSOT で、Electron main が `http://localhost:{port}` を
  導出して loadURL する。port が worktree 単位で分かれるため、複数 worktree の並列 `pnpm dev` が
  可能。esbuild + electron の起動は Vite より速いため、初回 load の ERR_CONNECTION_REFUSED は
  did-fail-load で retry する
- `pnpm --filter @gozd/electron build:app` — buildApp.ts が electron-builder
  （`electron-builder.yml` + CLI override）を呼び、無指定では `out/mac-arm64/Gozd Local.app`
  （local channel）を生成する。stable identity（`Gozd.app`）は release CI が
  `GOZD_BUILD_CHANNEL=stable` で焼き込むビルドだけが名乗れる（[release.md](release.md)）。
  renderer は `.app` 同梱の Vite build 成果物を `loadFile` で読む
  （Vite build は `base: "./"` の相対パスなので file:// で成立する）

### electron-builder の前提

- workspace は `nodeLinker: hoisted`（pnpm-workspace.yaml）。Electron 公式処方
  「パッケージングツールチェーンは npm 式に物理配置された node_modules を前提とする」に従う。
  これにより electron-builder 標準の prod 依存収集（node-pty / @parcel/watcher + transitive）が
  そのまま機能する
- `asar: true` + `asarUnpack`（Electron / electron-builder の公式推奨。`asar: false` は
  「strongly not recommended」警告が出る）。`ELECTRON_RUN_AS_NODE` は asar 統合をバイパスするため、
  その経路で実行される `dist/cli.cjs` だけ unpack する（esbuild で全依存 bundle 済みの単一ファイルなので
  unpack は 1 ファイルで済む）。native module（node-pty / @parcel/watcher の `.node`）は asar 内から
  dlopen 不可のため unpack する。将来 stable で署名する際に ASAR integrity（`embeddedAsarIntegrityValidation`
  Fuse）へ地続きで進めるよう asar を有効に保つ。bin/ zsh/ views/ は extraResources で asar の外
- `electronDist` は指定しない（electron-builder 標準の zip ダウンロード + 展開）。unpacked dist を
  渡すとコピー経路が Electron.app 最上位の空 `.lproj`（macOS のアプリ言語判定に使われる）を
  落とし、renderer の Intl ロケールが en-US に固定される
- bundle id は `io.github.miyaoka.gozd.electron`
- `build:app` が `buildVersion`（Info.plist の `CFBundleVersion`）に HEAD のコミット日時 + hash を
  注入する。About パネル括弧内のビルド識別と、wrapper の `~/Applications` 同期の比較キーを兼ねる。
  未コミット変更を含むビルドは hash に `-dirty` が付き、表示 hash と `.app` の中身の不一致が
  自己申告される。electron-builder ステップでの注入なので packaged にしか値が存在せず、
  「dev には出さない」が配管なしで保証される。dev はビルド元 worktree でコードが見えるため
  識別情報を焼き込まない
- バージョン番号（`CFBundleShortVersionString`）は `apps/electron/package.json` の version が
  SSOT。stable リリース前に人間が bump し、canary リリースは CI が tag 由来の version を
  `extraMetadata.version` でビルドにのみ焼き込む（repo には書き戻さない。[release.md](release.md)）
- `productName` は yml と package.json の両方に必要。yml 側は Info.plist（About パネルの表示名 /
  `.app` 名）にだけ効き、実行時の `app.name`（メニューの About / Hide / Quit ラベル）は同梱
  package.json から読まれる。片方だけだと About とメニューで名前が食い違う

### `.app` 内の配置

```text
Gozd.app/Contents/
├── MacOS/Gozd                       # Electron メインバイナリ
└── Resources/
    ├── icon.icns
    ├── app.asar                     # files（esbuild 成果物）+ prod node_modules をアーカイブ
    ├── app.asar.unpacked/           # asarUnpack で展開された実ファイル
    │   ├── dist/cli.cjs             # ELECTRON_RUN_AS_NODE で実行するため実ファイル必須
    │   └── node_modules/            # node-pty / @parcel/watcher（dlopen する native）
    └── app/                         # extraResources（asar の外の実ディレクトリ）
        ├── views/main/              # renderer の Vite ビルド成果物
        ├── bin/gozd                 # シェルラッパー
        ├── bin/gozd-cli             # CLI shim（app.asar.unpacked/dist/cli.cjs を ELECTRON_RUN_AS_NODE で実行）
        ├── channel                  # channel marker（stable / local。buildApp.ts が焼き込む）
        └── zsh/                     # gozd zsh init チェーン
```

### `bin/gozd` シェルラッパーの動作

`apps/electron/resources/bin/gozd` は bash スクリプト。

- **cold start**（アプリ未起動）: CLI が launch request ファイルを `$TMPDIR/gozd-{channel}-launch/` に
  書き出し → `open` で `.app` を起動 → アプリが起動時に最古の 1 件を consume して renderer に push
  （読み取り失敗でも対象ファイルは削除する。壊れた request の残留は起動のたびに失敗し続けるため）
- **warm start**（アプリ起動済み）: CLI がソケット経由で `OpenMessage` を送信 → renderer に push
- **hook コマンド**: アプリ起動チェックをスキップし、CLI を直接実行

stable channel の wrapper は cold start 時に `~/Applications/Gozd.app` へ自己同期
（`CFBundleVersion` 比較 + APFS clone の atomic 差し替え）してから固定パス側を `open` する。
Dock ピン / Spotlight が固定パスを指し続けるための機構（[release.md](release.md)）。

### gozd-cli（TS 実装）

`src/cli.ts` を esbuild で `dist/cli.cjs` に全依存 bundle する。実行 shim は 2 種:

- dev: `apps/electron/bin/gozd-cli`（node で実行）
- packaged: `resources/bin/gozd-cli`（`ELECTRON_RUN_AS_NODE=1` + 同梱 Electron バイナリ。
  ユーザー環境に Node を要求しない）

ワイヤは NDJSON 1 行の `ClientMessage` JSON。launch dir の channel は
`GOZD_SOCKET_PATH` のファイル名（`gozd-<channel>.sock`）から導出するため socket と自動で揃う。

### channel によるリソース分離

socket / launch dir / claude settings は channel で分離する。packaged `.app` は build 時に
焼き込まれた marker（`Resources/app/channel`）で `stable`（release CI ビルド）/ `local`
（無指定の `build:app`）に分かれ、未パッケージ（`electron .`）は `dev-<worktree hash>`
（electronRoot の realpath から導出）。packaged 判定は `gozdEnv.isPackaged`（`__dirname` が
`process.resourcesPath` 配下かどうか）。marker が欠落・不正な packaged ビルドは起動時エラーで
止める（channel identity の詳細は [release.md](release.md)）。

dev channel を worktree 単位に分けるのは、socketServer が listen 前に既存 socket を
unlink するため。channel が固定だと 2 個目の `pnpm dev` が先発インスタンスの稼働中 socket を
奪い、先発が spawn 済みの PTY からの hooks が後発に流れて ClaudeStatus が静かにずれる。
CLI は socket ファイル名から channel を逆導出する（`cliOps.ts`）ため、hash 付き channel にも
変更なしで追従する。

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

- **request**（応答あり）: renderer → main。`ipcRenderer.invoke("rpc:request", path, body)` →
  `rpcDispatcher.ts` のルート表 → 実装は `routes.ts`。ワイヤは `@gozd/rpc` 型の plain data
  （structured clone。push 方向と同じ意味論）
- **push**（一方向）: main → renderer。`webContents.send("rpc:push", type, payload)` →
  preload 経由で renderer の `initRpcDispatcher` が購読

renderer の購読登録（module 実行）は `did-finish-load` 前に完了するため、load 完了後の push は
落ちない。renderer 再構築中（Vite フルリロード等）に落ちた push は、mount 時の pull hydrate +
onMessage 購読の貼り直しで構造的に回復する（Swift 期から続く規律。落としてはいけない push は
「1 度の取りこぼしで UI 状態が永続的にずれる」もので、それらには観察ログを残す）。

詳細なメッセージ一覧は [rpc.md](rpc.md)。

### バイナリの配信（preview の画像 / SVG）

専用経路を持たない。画像 / SVG もテキストと同じ read RPC で `WireBytes`（生 bytes）として
運び、renderer 側で表示形へ変換する。旧 `gozd-file://` protocol（`<img>` への raw bytes
直配信 scheme）は、structured clone ワイヤへの移行で「JSON string はバイナリを保持できない」
という前提ごと廃止した。

セキュリティ: renderer 内に URL 越しにファイルを読む口が存在しないため、rendered HTML
（markdown 等）に `<img src>` を書いてもローカルファイルには到達できない。ファイル読みへの
到達経路は first-party の renderer コードだけが呼べる RPC のみ（DOMPurify が script を除去する
ため、描画されたコンテンツから RPC bridge は呼べない）。

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
- 除外（`AppConfig.watcherExclude` / VS Code の `files.watcherExclude` 相当）は **working-tree
  root の subscription にだけ**適用し、git dir root には掛けない。git dir を除外すると
  ref / HEAD / index イベントを落として branch / status 検知が壊れるため

### @parcel/watcher の utilityProcess 隔離

`@parcel/watcher` の subscribe は **Electron の utilityProcess（別 OS プロセス）に隔離**し、
main は `fsWatchRegistry` の transport 越しに subscribe / unsubscribe を仲介する。

- **なぜ別プロセスか**: native FSEvents コールバックスレッドが glob 照合中に heap 破壊で trap
  すると、in-process では main プロセスごと落ちる。Electron の renderer / GPU 隔離は native
  addon を main に同居させるため効かない。subscribe を別アドレス空間に閉じ込めることで、
  native crash をそのプロセス内で完結させ main を巻き込まない（VS Code の
  UniversalWatcherClient と同じ切り方）
- **境界**: 隔離プロセスが持つのは subscribe のみ。classify / git / push は main に据え置く。
  git サブプロセス生成や RPC ブリッジを別プロセスに複製しないための最小境界
- **crash 復帰**: main が process の異常終了を検知して respawn し、確立済み subscription を
  全再確立する。連続失敗は上限で打ち切る（落ちたまま監視が黙って止まると push を落とすため、
  停止は観察可能化する）
- **観察可能性**: crash / respawn / 隔離プロセス内部ログの診断は `debugLog` push で renderer の
  event-log パネル（`logEvent`）へ流す。自己修復する crash は toast にせず、監視が完全停止した
  terminal ケースだけ `notify` でトースト通知する（VS Code の「行動可能なものだけ user-facing、
  それ以外はログチャンネル」と同じ切り分け）。main 側の push ヘルパー（`makeDebugLogPush`）は
  event-log push に加えて `console.error` の floor も出す二段構え。event-log push は packaged UI で
  見えるが push 先 window が未束縛 / クローズ時は無音で落ちるため、dev 可視かつ push 落下時も残る
  floor で失敗経路の silent drop を防ぐ。隔離プロセス（`watcherProcess`）側の child stderr は
  不可視なので、そちらは `console.error` を使わず log message を main へ投げる分業とする

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

### node-pty の utilityProcess 隔離

node-pty の `IPty` は **Electron の utilityProcess（pty 専用 host。`ptyHost`）に隔離**し、main は
`ptyClient` の transport 越しに spawn / write / resize / kill を仲介する。main は node-pty を
一切 import せず、main のバンドルに node-pty への参照は存在しない（唯一の import 元は host entry
`ptyHost`）。

- **なぜ別プロセスか**: node-pty の exit callback は「native waitpid スレッド → ThreadSafeFunction →
  JS の onexit」という非同期経路で、子の reap がアプリ終了時の env teardown（`node::FreeEnvironment`
  → `CleanupHandles` → `uv_run` の drain）と競合すると、破壊中 isolate 上で `cb.Call` が失敗し
  node-addon-api が二重 throw して `SIGABRT` する。これは in-process では原理的に消せない
  （microsoft/vscode issue243952 も未解決）。IPty を丸ごと別アドレス空間へ移し、crash する env を
  使い捨ての host に閉じ込めるのが唯一の構造的解（VS Code ptyHost モデルと同型）。watcher の
  native heap 破壊とは別クラスの crash だが、封じ込めの思想は共通
- **境界**: host が持つのは IPty のライフサイクルと data のみ。env 構築（`buildPtyEnv` の
  `GOZD_PTY_ID` 注入等）・session 紐付け（`ptySessions`）・portScanner の pid 帰属は main に据え置く。
  pid は spawn 応答で host から返して main が引き取る
- **flow control**: MB/s 規模の onData を host→main IPC で溢れさせないため backpressure をかける。
  host は未 ack 文字数を数え、閾値超で `pty.pause()`、main が転送後に ack を返し、下限を割ると
  `resume()`（VS Code FlowControlConstants と同じ watermark 方式）
- **crash 復帰が watcher と違う理由**: watcher は re-subscribe で透過復帰できるが、pty host が落ちると
  配下の shell / claude セッションは子プロセスごと死ぬため蘇生できない。よって host crash 時は
  respawn して復元せず、live な全 pty を exited として renderer に通知（`ptyExit`）し、次の spawn 要求で
  host を lazy 再起動する。app 丸ごと即死より厳密に改善（app は生存、当該端末だけ死ぬ）
- **quit 経路**: アプリ終了時は `ptyClient.dispose()` で host を terminate する。host の env teardown
  （pending TSFN の drain crash 含む）は使い捨て host 内で完結し、main は `child exit` を観測して
  cleanly quit する
- **観察可能性**: crash / host 内部ログは main 側の `makeDebugLogPush`（`console.error` floor +
  event-log push の二段構え）へ流す（watcher と同じ規律）。host（隔離プロセス）側の child stderr は
  不可視なので、host からは `console.error` を使わず `log` message を main へ投げる

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
> 永続ファイルへの cross-process ロックは未実装。複数インスタンス（dev / stable、または
> 複数 worktree の並列 `pnpm dev`）を同時起動した場合、各ストアの `load → mutate → save` が
> 並走すると、最後に save したプロセスが他方の変更を上書きする可能性がある（last-write-wins を
> 許容する設計判断。`tasks.json` は project 単位ファイルのため、別プロジェクトを扱う限り実害は
> グローバルな `app-state.json` / `electron-window.json` に限られる）。

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

| Claude hook          | gozd イベント    | 送信経路    | 取得データ                                                             |
| -------------------- | ---------------- | ----------- | ---------------------------------------------------------------------- |
| `SessionStart`       | `session-start`  | CLI 経由    | `ptyId`, `session_id`, `source`                                        |
| `SessionEnd`         | `session-end`    | CLI 経由    | `ptyId`, `session_id`                                                  |
| `UserPromptSubmit`   | `running`        | nc 直接送信 | `ptyId`                                                                |
| `Stop`               | `done`           | CLI 経由    | `ptyId`, `last_assistant_message`, `pending_work`, `has_teammate_task` |
| `PermissionRequest`  | `needs-input`    | CLI 経由    | `ptyId`, `tool_name`, `tool_input`                                     |
| `PostToolUse`        | `tool-done`      | nc 直接送信 | `ptyId`                                                                |
| `PostToolUseFailure` | `tool-failure`   | nc 直接送信 | `ptyId`                                                                |
| `StopFailure`        | `stop-failure`   | CLI 経由    | `ptyId`, `last_assistant_message`                                      |
| `SubagentStart`      | `subagent-start` | CLI 経由    | `ptyId`, `agent_id`                                                    |
| `SubagentStop`       | `subagent-stop`  | CLI 経由    | `ptyId`, `agent_id`                                                    |
| `TeammateIdle`       | `teammate-idle`  | CLI 経由    | `ptyId`, `teammate_name`                                               |

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
