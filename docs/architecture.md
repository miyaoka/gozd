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

生成物は git に commit しない。`packages/proto-ts/src/generated/` と `packages/proto-swift/Sources/GozdProto/*.pb.swift` は `.gitignore` で除外し、`packages/proto/` の `prepare` script (`buf generate`) が両言語の出力を一括生成する。`buf.gen.yaml` の `clean: true` により 1 回の `buf generate` で ts / swift 出力が揃うため、生成 hook は `packages/proto/` 1 箇所だけに置く（proto-ts / proto-swift 側には置かない）。手動再生成は `pnpm --filter @gozd/proto-schema build`。`buf.gen.yaml` では BSR のリモートプラグイン (`buf.build/community/stephenh-ts-proto` / `buf.build/apple/swift`) をバージョン pin して指定する（具体バージョンは `buf.gen.yaml` を参照）。

生成 trigger は以下の経路で発火する。**自動発火するのは `node_modules` が outdated な状態で pnpm が install を起動するときだけ**であり、`.proto` だけを編集して `pnpm dev` 等を再実行しても自動再生成はされない。

| 入口                                                            | 自動発火する条件                                                | 発火する仕組み                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm install`                                                  | デフォルト設定下では常に                                        | workspace 全体の `prepare` lifecycle で `packages/proto` が発火 |
| `pnpm run` 系 (`pnpm dev` / `pnpm build` / `pnpm --filter ...`) | `node_modules` が outdated なときのみ (pnpm 11 の auto-install) | auto-install が起動 → `prepare` 発火                            |

`node_modules` が up-to-date な状態で `.proto` だけを編集した場合は、pnpm 11 の `verifyDepsBeforeRun` は outdated 判定の対象にしないため、**手動で再生成する必要がある**:

```bash
pnpm --filter @gozd/proto-schema build
```

`.proto` 編集時の再生成は手動コマンドで行う運用契約とする。

`swift build` / Xcode で `apps/native` を直接開く経路は pnpm を経由しないため、初回のみ `pnpm install` か `pnpm --filter @gozd/proto-schema build` を 1 回叩いて生成物を作る。

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

`pnpm dev` は `apps/native/scripts/build-dev-app.sh` で **dev 専用 `.app`**（dock icon が dev カラー、タイトルが `gozd (dev)`）を生成し、renderer は Vite dev server (`http://localhost:<port>`、port は root `package.json` の `dev` script で `GOZD_DEV_VITE_PORT` env として設定し Vite / Swift 両方が SSOT として受け取る) から読み込む。Vite default の 5173 ではなく gozd 固有ポートを使い、かつ `vite.config.ts` で `strictPort: true` を指定する。理由は別 worktree からの二重 `pnpm dev` / 別 Vite アプリと衝突したときに fallback で別ポートを掴むと、Swift `.app` は env から受け取った port 固定なので先発の Vite に繋がって「別 worktree のはずなのに先発の内容が表示される」サイレント事故になるため。`pnpm build` は `build-app.sh` で stable 版 `.app` を生成し、renderer はバンドル内 `views/main/index.html` を `gozd-app://` URLSchemeHandler 経由でロードする。

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
- native の dev スクリプトは `GOZD_DEV_PROJECT_ROOT=$(repo root)` を渡して `apps/native/scripts/build-dev-app.sh` を実行する。port は root `pnpm dev` script が設定する `GOZD_DEV_VITE_PORT` env を継承する
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

## WebPage の navigation policy

renderer 内の外部リンク (`<a target="_blank">` / `window.open`) を OS のデフォルトブラウザに渡すには `WebPage.NavigationDeciding` 準拠の `ExternalLinkNavigationDecider` (`apps/native/Sources/Gozd/ExternalLinkNavigationDecider.swift`) を `WebPage(configuration:navigationDecider:)` に差し込む必要がある（WWDC25「Meet WebKit for SwiftUI」公式パターン）。デフォルトでは main frame が外部 URL に置換されて renderer の UI 全体が消えるため、構造的に必要な防壁。

判定軸は **scheme による 3 分岐** に統一する:

- http(s) かつ dev mode の Vite dev origin (`http://localhost:$GOZD_DEV_VITE_PORT`) → 内部扱いで `.allow`
- http(s) かつそれ以外 → 外部とみなして OS のデフォルトブラウザに渡し `.cancel`
- それ以外の scheme（`gozd-rpc://` / `gozd-app://` / `gozd-file://` / `about:` / `file:` 等）→ `.allow`

`navigationType`（`linkActivated` / `formSubmitted` / `.reload` 等）や `action.target` の値には依存しない。renderer は単一 WebPage 上に Vue UI を構築する設計なので、main frame であれ subframe であれ http(s) への遷移は外部 host なら OS ブラウザで開くのが期待挙動であり、`<a href>` 以外の経路（form submit / window.open / meta refresh 等）でも構造的に外部送りで揃える。起動時の `page.load(http://localhost:$GOZD_DEV_VITE_PORT/)` は dev origin allow 経路で透過する。

dev mode で参照される `$GOZD_DEV_VITE_PORT` は **port 数値のみ** を受け取る。scheme + host は `http://localhost` 固定契約のため env で渡さない (Vite dev URL の host は常に `localhost`、HTTPS は使わない)。

外部 URL の launch 失敗（壊れた URL / 既定ブラウザが解決不能 等）は具体的な error 情報込みで stderr に残す（`[NavigationDecider] failed to open external URL: <url>: <error>` 形式、silent drop 禁止規律と整合）。

renderer 側の `<a href>` には `target="_blank" rel="noopener noreferrer"` を付ける（defense in depth）。decider が `.cancel` する前の thin window で WebKit が referrer / opener を組み立てる可能性に備える保険であり、decider 経路と二重防御で揃える契約。`window.open` への迂回や `e.preventDefault()` での workaround は不要。

副作用として、markdown preview ([preview.md](preview.md)) で render される `[text](https://...)` 由来の `<a href>` も同じ decider を経由するため、すべて外部ブラウザで開かれる。WebView 内で main frame を置換されるリスクが構造的に無くなる代わりに、「markdown 内のリンクは必ず外部ブラウザで開く」という挙動が決定的になる。

## 通信経路

### gozd-rpc:// URLSchemeHandler（renderer ↔ native）

renderer は `fetch("gozd-rpc://localhost/{path}", { method, body })` で RPC を呼ぶ。`RpcSchemeHandler`（`apps/native/Sources/Gozd/GozdApp.swift`）が HTTP 風のレスポンスにラップして返す。実際のロジックは `RpcDispatcher`。

native → renderer の push は `WebPage.callJavaScript("window.__gozdReceive(type, payload)", ...)` で行う。配送結果は `pushToRenderer` ヘルパー（`apps/native/Sources/Gozd/WebPagePush.swift`）が stderr にログする。silent drop は禁止 — 1 度の取りこぼしで UI 状態が永続的にずれるため、観察可能性を全 push に必須として課している。

「renderer not ready」は 2 段で起きる: page 未初期化（`page == nil`）と、page はあるが receiver（`window.__gozdReceive`）未登録。後者は HTML ロード完了（JS context が live）と JS bundle 実行完了（`main.ts` の `initRpcDispatcher()` が走り receiver 登録）のラグで生じ、dev では Vite dev server からモジュールグラフを HTTP fetch する分この窓が広い。`callJavaScript` は JS context が live なら即実行するため、receiver 未登録時に素で叩くと `__gozdReceive is not a function` の JS 例外になる。`pushToRenderer` は receiver の有無を JS 側で判定して未登録なら drop する。

ログの出し分けは renderer ready 到達を境にする。配送成功で `RendererReadiness.isReady` を立て、receiver 未登録の drop は ready 到達前なら bootstrap 窓の期待される正常系として黙す（毎起動の startup ノイズを避ける）。ready 到達後の drop だけ `[GozdApp] push dropped (receiver lost)`、JS 例外は `[GozdApp] push failed`、page 未初期化は `[GozdApp] push dropped (page not ready)` としてログする。タイマー駆動の push（PortScanner の `serverPortsChange`）が bootstrap 窓に当たるが、全件 snapshot の周期再送 + mount 時 pull hydrate で回収されるため drop しても自己回復する。

- **request**（応答あり）: `renderer → native`。ptySpawn, fsReadFile, gitStatus 等
- **push**（一方向）: `native → renderer`。ptyText, hook, fsChange, gitStatusChange 等

詳細なメッセージ一覧は [rpc.md](rpc.md)。

### CORS 運用規律 (`gozd-rpc://` / `gozd-file://`)

WKWebView (`macOS 26 WebPage` + `URLSchemeHandler`) は custom scheme の fetch でも標準 CORS check を適用する。WebKit は request を native handler まで送り、**response 受信後**に `Access-Control-Allow-Origin` ヘッダを評価する。ヘッダが request の `Origin` を許可するなら fetch promise が resolve、許可しない (ヘッダ無し含む) なら TypeError で reject する。WebKit Bug 199064 / 201180 から推測される「scheme allowlist 未登録で send 前に reject」は macOS 26 公開 API 経路では成立しない (Bug 205198 の CORS 許可マーキング private SPI なしに標準 CORS check が走る)。

一方 `<img>` / `<video>` / `<audio>` 等は **passive content** として CORS check 対象外で読み込まれる。`fetch()` / `canvas.getImageData()` だけが CORS check 対象。この仕様差を活かして「画像表示は通す、bytes の機械的回収は止める」を両立できる。

renderer の origin は dev (`http://localhost:$GOZD_DEV_VITE_PORT`) / build (`gozd-app://localhost`) の 2 つだけ存在し、`gozd-rpc://localhost` / `gozd-file://localhost` から見ると scheme が異なるため**常に cross-origin** になる。

採用している防御規律:

- **`gozd-rpc://`**: request の `Origin` が allowlist (`gozd-app://localhost` + dev 時のみ `http://localhost:$GOZD_DEV_VITE_PORT`) に含まれるときのみ `Access-Control-Allow-Origin: <origin>` を echo back + `Vary: Origin` を併送する。それ以外 (空文字 / 攻撃 origin) はヘッダを返さない → WebKit が CORS reject。renderer 内 XSS が `fetch("gozd-rpc://localhost/fs/readFileAbsolute", ...)` で機密ファイル bytes を回収する経路を構造的に塞ぐ
- **`gozd-file://`**: `Allow-Origin` ヘッダを一切返さない方針。`<img>` は passive content として CORS check 対象外で表示可能、一方 `fetch()` / `canvas.getImageData()` は CORS reject される。「画像は見える、bytes は機械的に取れない」を両立する規律

両方とも `Allow-Origin: *` (全 origin 許可) は禁止。`*` は WebKit に「許可」を伝える正当なヘッダだが、XSS 経路で任意 origin からの bytes 回収を構造的に許してしまう。

### gozd-file:// URLSchemeHandler（preview の `<img>` 配信）

preview ペインの image / SVG 表示専用。`<img src="gozd-file://localhost/{fs|git}?dir=<absDir>&path=<relPath>&v=<n>">` の URL を `FileServerSchemeHandler`（`apps/native/Sources/Gozd/FileServerSchemeHandler.swift`）が raw bytes で返す。

- `/fs` : `FSOps.readFileBytes`（`resolveSafe` で path traversal 防止）
- `/git`: `GitOps.showFile`（= `git show HEAD:<path>`）

テキスト系のファイル読みは従来通り `gozd-rpc://` 経由で `FileReadResult.content: string` を使う。proto3 `string` がバイナリを保持できない問題は画像 / SVG 経路だけ別 scheme に分けることで回避する（proto 全体への破壊変更を避ける判断）。詳細は [preview.md](preview.md) を参照。

### SSOT push の dir filter 規律

FSEvents 経由の push は ms オーダーで届くが、watch 開始往復中の取りこぼしや、`callJavaScript` の失敗で 1 度の event を落とすと、UI 状態と git refs の実体が永続的にずれる。これを防ぐため、全 push に source `dir` を載せ、購読側が自分の責務に応じて filter する契約を統一する。

- **payload に dir を載せる**: `gitStatusChange` / `branchChange` / `remoteRefsChange` / `worktreeChange` / `fsWatchReady` すべての push payload は `dir` を必須フィールドとして持つ。購読側はこの `dir` を見て active dir / 所有 repo を判定する。dir を載せないと N watch × M subscriber の cross product 発火が避けられず、累積発火が外部リソース（GitHub rate limit 等）を食い潰す
- **再同期トリガー**: `useFsWatchSync` が `rpcFsWatch` 成功ごとに renderer 内部で `fsWatchReady` を **dir 1 件につき 1 push** 発射する。GitGraphPane は active と同 repo の event だけ `loadLog`、useSidebarData は source dir の所有 repo を再 fetch する
- **active filter / source-dir filter の使い分け**: pane の責務 + event の種類で filter 方向を変える
  - GitGraphPane（active worktree の git log を表示）:
    - `gitStatusChange` は **per-worktree** な ahead/behind / branchHead を運ぶため `dir !== worktreeStore.dir` なら早期 return（strict dir match）
    - `branchChange` / `remoteRefsChange` / `fsWatchReady` は primary worktree dedup により source dir が active と一致しないケースがある（secondary worktree を選択中など）。`!repoStore.isSameRepoAsActive(dir)` で **同 repo 判定** して受ける
  - useSidebarData（全 repo の worktree list を per-rootDir で並列管理）: `findRepoOwning(dir).rootDir` を fetch
- **status payload に branch.head を含める**: `git branch -m` は HEAD の commit OID を変えないため、`gitStatusChange.head` だけで判定すると rename を取りこぼす。`git status --porcelain=v2 --branch` が出す `# branch.head <name>` を payload に乗せ、renderer 側は `branchHead` の変化でも `loadLog` を発火する

> [!NOTE]
> `rpcGitRefsDigest` 整合性チェッカは廃止した。全 worktree watch + per-dir filter で local refs に対する SSOT push の到達率は実用的に十分であり、low-frequency pull で push 到達率を二重チェックするのは予防的逃げ道に該当する。push 不達が観測されたら原因を直接修正する。
>
> 一方 PR list は別経路で扱う。`gh pr create` (既 push branch) / `gh pr edit` / `gh pr comment` 等の **local refs を動かさない GitHub mutation** は push 経路では原理的に到達不能で、これらは gozd の primary use case (Claude / ユーザーが worktree で並列に PR を作る) の中核。これを反映する唯一の正規経路として、active worktree 1 個に scope を絞った 60 秒間隔の `gh pr list` polling を GitGraphPane 内に持つ。fan-out を全 worktree に広げないことで rate limit の累積発火を起こさない。詳細は [git.md](git.md) を参照。

### FSWatch の対象スコープ

`useFsWatchSync` は **開いている全 repo / 全 worktree の dir** を `rpcFsWatch` に登録する。watch 対象の集合は `useRepoStore` の computed `fsWatchTargetDirs`（`repos[*].worktrees` の path、非 git project は rootDir 自身）として store 側で派生し、`useFsWatchSync` はこれを `watch` で観測して差分を `rpcFsWatch` / `rpcFsUnwatch` で発射する。派生値の所有を SSOT である store に置くことで、`useFsWatchSync` は reactive 値 1 つを watch する素直な構成になる。

- gozd は「window 内マルチ repo + マルチ worktree」が機能要件なので、active 1 dir だけ watch する設計だと別 repo / 別 worktree の commit / rename / push を取りこぼす
- 別 repo は commonGitDir が完全に独立。1 dir だけ watch ではこれを救済できないため、全 worktree を均等に対象とする
- per-worktree git dir 配下の `HEAD` / `index` 変化（commit / checkout 完了の即時反映）も worktree ごとに独立して watch される
- 非 git project（`isGitRepo === false`）は rootDir そのものを watch（fsChange のみが意味を持つ）
- `rpcFsWatch` / `rpcFsUnwatch` はどちらも native 側 `FSWatchRegistry` で idempotent。並列発射でも整合性は崩れない
- watch 数の上限は OS の FSEventStream slot に依存するが、実用域（数十〜百 worktree）で問題になる事例は確認されていない

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
        ├── tasks.json                    # プロジェクト固有: Task 一覧（Claude session_id を task.session_id に持つ）
        └── config.json                   # プロジェクト固有: worktreeSymlinks 等
```

Claude セッションの sessionId は専用ストアを持たず `tasks.json` の `task.session_id` を SSOT とする。worktree の resume 復元（`rpcResumableSessionList`）も tasks.json から `sessionId != "" && !closedByUser` を引いて導出する（[workspace.md](workspace.md)）。

`AppStateStore` / `AppConfigStore` / `ProjectConfigStore` の load は `JSONDecodingOptions.ignoreUnknownFields = true` を有効にし、将来バージョンが増やしたフィールドを含む JSON を旧 binary が読んでも parse 失敗させない。

save の未知 top-level キーの扱いはストアで分かれる。`AppStateStore` のみ、既存ファイルを raw dict として読み新 state と shallow merge して未知 top-level キーを保持する（`knownTopLevelKeys` を merge 前に落とすことで、proto3 JSON が空 repeated / default scalar を省略する性質による「最後の repo を消したのに古い `sidebarRepos` が残る」事故を防ぐ）。dev/stable や複数バージョン同時起動で、別バージョンが書いた top-level キーを上書き save で落とさない要件があるため。一方 `AppConfigStore` / `ProjectConfigStore` は proto message を `jsonString()` で丸ごと書き、未知 top-level キーは保持しない。

`TaskStore` (`tasks.json`) の load は parse 失敗時に **空オブジェクトで上書き save** する。永続データに後方互換を作らない (CLAUDE.md 規約) ため、proto schema 進化で旧 JSON が parse 失敗した場合は新規初期化が期待挙動。加えて取得経路上、これは主データ (例: `git worktree list`) を JOIN する立場にあり、load 経路から throw が伝播すると主データ取得経路を巻き込むため、空オブジェクトに倒す。stderr に reinitialized ログを残して観察可能性を確保する。

### スコープの使い分け

| スコープ       | 保存先                                  | 例                                            |
| -------------- | --------------------------------------- | --------------------------------------------- |
| グローバル     | `~/.config/gozd/` 直下                  | ウィンドウフレーム、repo 並び順、ユーザー設定 |
| プロジェクト別 | `~/.config/gozd/projects/<projectKey>/` | Task、Claude session id、worktree スクリプト  |

### 新しい永続化データを追加するパターン

- `packages/proto/gozd/v1/*.proto` に request スキーマ（params / response）を追加し、`pnpm --filter @gozd/proto-schema build`（= `cd packages/proto && buf generate`）で TS / Swift 生成物を更新する
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
| `SessionStart`       | `session-start` | CLI 経由    | `ptyId`, `session_id`, `source`    |
| `SessionEnd`         | `session-end`   | CLI 経由    | `ptyId`, `session_id`              |
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
