# アーキテクチャ

プロセス構成と、プロセス境界を跨ぐときに守る契約。

## プロセス構成

```text
┌─────────────────────────────────────────────┐
│ renderer                                     │
│ UI 全体。ファイル I/O と外部プロセス起動を持たない │
└──────────────────┬──────────────────────────┘
                   │ IPC（structured clone）
┌──────────────────┴──────────────────────────┐
│ main                                         │
│ RPC ディスパッチ / git / 永続化 / ソケット受付   │
└──────────────────┬──────────────────────────┘
                   │ Unix ドメインソケット（NDJSON）
┌──────────────────┴──────────────────────────┐
│ CLI・Claude hooks                            │
└─────────────────────────────────────────────┘
```

main はさらに、native 拡張を使う責務を専用の隔離プロセスへ切り出す（PTY / ファイル監視）。

| プロセス     | 持つもの                                                   | 持たないもの                     |
| ------------ | ---------------------------------------------------------- | -------------------------------- |
| renderer     | UI 状態、表示判断、worktree 相対パスの解決基準             | ファイル I/O、プロセス起動       |
| main         | RPC ルーティング、git 実行、永続化、hook の受付            | native 拡張の直接ロード          |
| PTY host     | 疑似端末のライフサイクルと入出力                           | 環境変数の構築、セッション紐づけ |
| watcher host | ファイル監視の subscribe                                   | 変更の分類、git 実行、push       |
| CLI          | ソケットへの 1 行送信、cold start 用の起動要求ファイル生成 | アプリ状態                       |

## プロセス境界を跨ぐ型

RPC の型（request / response / 永続化 schema / socket message）は単一のパッケージを SSOT に置き、
renderer と main が同じ定義を参照する。両端が同型を見るためワイヤ変換層は存在しない。

- 境界を通せるのは **plain data**（JSON 相当の値と生 bytes）だけ。reactive proxy のような
  exotic object は複製できず reject されるため、呼び出し側が plain data を渡す責務を持つ
- **バイナリは第一級で運ぶ**。文字列に詰め替えず、生 bytes のまま渡す
- バイナリを送出するとき、**送る範囲だけを持つ独立したバッファに複製してから渡す**。共有プールを
  背景に持つ view をそのまま渡すと、backing buffer ごと複製されて無関係なデータが同伴する
- socket を通る型にバイナリを載せない（NDJSON はバイナリを保持できない）
- `?` を持つフィールドは未設定を undefined で表す。永続化 JSON ではキー不在に対応する

### 信頼できない入力の正規化

プロセス境界を跨いで届く入力のうち、**gozd が書いたと保証できないもの**（永続ファイル、socket の
NDJSON）は受信側で正規化を通す。「フィールド不在 = default」は正常系の契約、「存在するが型違反」は
契約違反で、入力の性格で扱いが分かれる。

| 入力                           | 型違反の扱い                                       |
| ------------------------------ | -------------------------------------------------- |
| gozd が所有する state ファイル | 破損とみなし、ログを残して初期状態で上書き保存する |
| ユーザーが編集する設定ファイル | 該当フィールドだけ default に倒し、ログを残す      |
| socket 入力                    | 該当フィールドだけ default に倒し、ログを残す      |

ユーザーのファイルは書き換えない。gozd が所有するファイルは、壊れたまま読み続けるより初期化する。

## channel によるリソース分離

同時に動く複数のインスタンスが互いのリソースを奪わないよう、揮発リソースを channel で分離する。

| リソース          | パス                                          |
| ----------------- | --------------------------------------------- |
| ソケット          | `$TMPDIR/gozd-{channel}.sock`                 |
| launch request    | `$TMPDIR/gozd-{channel}-launch/`              |
| Claude hooks 設定 | `$TMPDIR/gozd-{channel}-claude-settings.json` |

channel の決まり方と identity の詳細は [release.md](release.md)。未パッケージの起動は worktree 単位で
別 channel になる。

worktree 単位に分けるのは、ソケットサーバーが listen 前に既存ソケットを unlink するため。channel が
共通だと後発インスタンスが先発の稼働中ソケットを奪い、先発が起動した PTY からの hook が後発へ流れて
状態が静かにずれる。CLI は接続先ソケットのファイル名から channel を逆算するため、channel の命名が
変わっても追従する。

永続データ（`~/.config/gozd/` / `~/.local/state/gozd/` 配下）は channel をまたいで **共有** する。

## 通信経路

### renderer ↔ main

- **request**: renderer から main への往復。応答を返す
- **push**: main から renderer への一方向

renderer の push 購読はウィンドウの load 完了より先に確立するため、load 後の push は落ちない。
renderer の再構築中に落ちた push は、mount 時の pull による再取得と購読の貼り直しで回復する。
この「mount で pull、変化で push」を全 feature で守ることで、push の取りこぼしが恒久的なずれに
ならない構造にする。

メッセージ一覧は [rpc.md](rpc.md)。

### SSOT push の dir filter 規律

ファイル監視由来の push は、1 度落とすと UI 状態と git の実体が恒久的にずれる。これを防ぐため、
全 push に発火源の `dir` を載せ、購読側が自分の責務に応じて filter する契約に統一する。

- **payload に dir を必須で載せる**。載せないと「N 個の監視 × M 個の購読者」の直積で発火し、
  累積発火が外部リソース（GitHub の rate limit 等）を食い潰す
- **監視の登録が成立した時点で、dir 1 件につき 1 回の再同期シグナルを流す**。監視の開始往復中に
  起きた変化を取りこぼさないため
- **filter の向きは pane の責務と event の種類で変える**。worktree 単位の意味を持つ event は
  厳密な dir 一致で、repo 単位の意味を持つ event は同一 repo 判定で受ける
- **status の push には現在の branch が指す commit を含める**。branch の rename は commit を
  動かさないため、HEAD の commit だけを見ると rename を取りこぼす

> [!NOTE]
> local な参照を動かさない GitHub 側の変更は push 経路では原理的に到達できない。この穴だけは
> polling で埋める（[git.md](git.md)）。

### バイナリの配信とセキュリティ境界

画像や SVG も専用経路を持たず、テキストと同じ読み取り RPC で生 bytes として運ぶ。

ファイル内容へ到達できる経路は 2 つに限る。

- first-party の renderer コードだけが呼べる RPC
- HTML preview 専用の配信 scheme（[preview.md](preview.md)）

後者は URL から読める口だが、配信範囲は preview が登録した root 配下に限られ、応答の CSP で
script 実行と外部通信を落とす。描画されたコンテンツ（markdown 等）から RPC bridge を呼べないのは
sanitizer が script を除去するため、配信 scheme を参照できないのは sanitizer の URI allowlist が
未知 scheme を落とすため。**sanitizer の設定を緩めるときはこの 2 つの境界を再確認する**。

### ソケットからの受付

ソケットのプロトコルは NDJSON で、1 行が 1 メッセージ。メッセージは `open`（パスを開く要求）と
`hook`（Claude Code の状態通知）のどちらか一方だけを持つ。

処理は逐次キューで直列化し、**同一 PTY のセッション系 hook が送信順に処理されること**を保証する。
decode 失敗は接続を切らずログに残す。

### `gozd` コマンドの起動経路

`gozd` は常に **既存ウィンドウへ要求を届ける**。新しいウィンドウは作らない。

| 状況              | 経路                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| アプリ起動済み    | ソケットへ open メッセージを送る                                       |
| アプリ未起動      | 起動要求ファイルを書いてアプリを起動し、アプリが起動時にそれを消費する |
| hook サブコマンド | アプリの起動確認を経ずソケットへ直送する                               |

起動要求ファイルは **読み取りに失敗しても削除する**。壊れた要求が残ると起動のたびに失敗し続ける。
複数溜まっている場合は最も古い 1 件だけを消費する。

## ファイル監視

### 監視スコープ

監視対象は **開いている全 repo / 全 worktree の dir**。active な 1 dir だけでは、別 repo・別 worktree で
起きた commit / rename / push を取りこぼす。マルチ repo × マルチ worktree は gozd の機能要件なので、
スコープを絞らない。

- worktree ごとの git dir も worktree 単位で独立に監視する
- 非 git のディレクトリは root 自身を監視する（ファイル変更だけが意味を持つ）
- 監視の登録 / 解除は冪等
- **包含関係にある root を重ねて登録しない**。同一の変更が二重配送されるため、最小被覆集合だけを
  監視する

### 除外の適用範囲

ユーザー設定による除外パターンは **working tree 側の監視にだけ**適用し、git dir には掛けない。
git dir を除外すると参照や HEAD の変化を落とし、branch / status の検知が壊れる。

## native 拡張の隔離

native 拡張（PTY、ファイル監視）は main と同じアドレス空間に置かず、専用の隔離プロセスへ切り出す。
Electron の renderer / GPU 隔離は native 拡張を main に同居させるため、この用途には効かない。

**共通の契約**: 隔離プロセスが持つのは native 資源のライフサイクルだけ。分類・git 実行・push・
環境変数の構築・セッション紐づけは main に据え置く。git の起動や RPC 経路を別プロセスへ複製しない
ための最小境界。

**crash 後の扱いは資源の性質で分かれる**。

| 資源         | crash 時の挙動                                                              | 理由                                                      |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| ファイル監視 | 隔離プロセスを再起動し、確立済みの監視をすべて張り直す                      | 監視は再登録すれば透過的に復帰する                        |
| PTY          | 復元せず、生存中の全 PTY を終了として通知する。次の起動要求で遅延再起動する | 配下の shell やセッションは子プロセスごと死ぬため蘇生不能 |

監視の再起動は連続失敗で打ち切る。**打ち切って監視が止まった状態を無音にしない** — 止まったまま
黙っていると push を落とし続ける。

**PTY の入出力には backpressure をかける**。高スループットの出力が IPC を溢れさせないよう、
未確認のデータ量が閾値を超えたら読み出しを止め、転送済みの確認で再開する。

### 観察可能性

隔離プロセス由来の crash・再起動・内部ログは、UI のイベントログと標準エラー出力の**二段構え**で出す。
イベントログはパッケージ済みのアプリでも見えるが、送り先のウィンドウが未確立・クローズ時は無音で
落ちる。標準エラー出力はその落下時にも残る floor として機能する。

隔離プロセス側の標準エラー出力は誰にも見えないため、隔離プロセスからは直接出力せず main へ
ログメッセージを送る分業にする。

自己修復する crash はトーストにしない。**監視が完全に停止した終端ケースだけ**ユーザーに通知する。

## PTY 環境

PTY 起動時、親の環境変数を継承したうえで gozd 固有の値を重ねる。

> [!WARNING]
> PTY 起動要求における引数配列の契約は **argv 全体**（先頭要素がプログラム名）。

### gozd 固有の環境変数

| 変数                        | 用途                                          |
| --------------------------- | --------------------------------------------- |
| `GOZD_PTY_ID`               | PTY の識別子。hook イベントの発火元を特定する |
| `GOZD_SOCKET_PATH`          | ソケットのパス。CLI や hook コマンドの接続先  |
| `GOZD_CLI_PATH`             | CLI 実行 shim の絶対パス                      |
| `GOZD_CLAUDE_SETTINGS_PATH` | Claude hooks 設定ファイルのパス               |
| `GOZD_ZDOTDIR`              | gozd の zsh 初期化ディレクトリ                |
| `GOZD_ORIG_ZDOTDIR`         | gozd が上書きする前のユーザーの ZDOTDIR       |

### ターミナル環境変数

| 変数              | 値               | 用途                           |
| ----------------- | ---------------- | ------------------------------ |
| `TERM`            | `xterm-256color` | ターミナル種別                 |
| `COLORTERM`       | `truecolor`      | 24bit カラー対応               |
| `TERM_PROGRAM`    | `gozd`           | アプリ識別                     |
| `FORCE_HYPERLINK` | `1`              | OSC 8 ハイパーリンク出力を許可 |

これらは指定が無いときだけ埋める。呼び出し側が明示した値は上書きしない。

### zsh 初期化チェーン

PTY 起動時に `ZDOTDIR` を gozd の初期化ディレクトリへ差し替え、gozd の初期化ファイルがユーザーの
初期化ファイルを透過的に `source` する。ユーザーの設定を壊さずに gozd の注入を重ねるための構造。

```text
zsh 起動
  → gozd/.zshenv   → ユーザーの .zshenv を source → ZDOTDIR を gozd に戻す
  → gozd/.zprofile → ユーザーの .zprofile を source
  → gozd/.zshrc    → ユーザーの .zshrc を source → 関数と通知を注入
  → gozd/.zlogin   → ユーザーの .zlogin を source → ZDOTDIR をユーザー側に固定
```

注入するもの:

- **`claude` のラップ**: hooks 設定を自動で付与する。ユーザーが明示的に設定を指定した場合は
  そのまま通す
- **cwd 通知**: ディレクトリ変更のたびに OSC 7 で現在の cwd を送る（[terminal.md](terminal.md)）
- **起動意図の消費**: 環境変数で渡された「セッション再開」「自動起動」「セットアップスクリプト」の
  意図を 1 回だけ実行する

## 外部リンクの navigation 防壁

「この URL を OS に渡してよいか」の判定点は、**リンククリックを受け取れる層に 1 つだけ**置く。
層ごとに判定を持つと、同じリンクでも通った経路で開く / 開かないが変わる非対称が生まれる。

受け取れる層は frame によって違う。

| frame                    | クリックを受け取れる層 | 外部送りの担当 |
| ------------------------ | ---------------------- | -------------- |
| main frame（UI 本体）    | renderer               | renderer       |
| subframe（HTML preview） | 防壁のみ               | 防壁           |

subframe が例外なのは、previewed HTML が実 origin で配信され、renderer からクリックを傍受する経路が
無いため。

### 防壁: frame を動かさせない

全 webContents に一律で適用する。

- **新規ウィンドウ**: UI が自前で使う空ウィンドウだけを許可し、それ以外は作らせず **URL も OS に
  渡さない**。gozd に外部 URL を `window.open` する first-party コードは無いため、ここへ来る要求は
  描画コンテンツ由来か、リンクを受け取る層の取りこぼしだけで、渡せばその層の allowlist を迂回する
- **frame の遷移**: **原則すべて block**。例外は 2 つだけ
  - 開発時の renderer origin への **main frame の同一 URL 遷移**（開発サーバーのリロード）。
    同一 URL に絞るのは、同 origin の別 path を通すと描画コンテンツの root 相対リンクが UI 面を
    置換するため
  - **subframe の遷移**: preview 配信 scheme 内は許可、OS へ渡してよい scheme は OS へ、
    それ以外は block

block は必ずログに残す。

frame 単位で判定する API を使う。main frame でしか発火しない API では subframe が素通しになり、
previewed HTML のリンクが preview 面を置換する。

### renderer: OS に渡してよい URL を決める

外部を開く経路は 1 本に集約する。リンククリックを受け取る層（markdown 本文 / terminal のハイパー
リンク / filer の submodule リンク）はすべてこれを通し、allowlist 外は開かずに拒否して呼び出し側が
通知に倒す。

**scheme allowlist（http / https / mailto）は共有モジュールが SSOT** で、renderer と防壁が同じ述語を
見る。層ごとに別集合を持つと上記の非対称が生まれる。

markdown 本文は `#fragment` 単独を除く全リンククリックを既定動作から奪い、外部 URL は自分で
外部送りへ流す。残りの href だけを利用側に委ねる。外部送りを利用側任せにすると、購読しない
利用側でリンクが黙って死ぬ。

**クリックと中クリックの両方を同じ経路に通す**。中クリックは通常のクリックイベントを発火しないため、
片方だけ扱うと既定の新規ウィンドウ要求に落ち、この層の allowlist を迂回して OS に URL が渡る。

## データ永続化

ファイル I/O は常に main 側で行い、renderer は RPC 経由でアクセスする。

XDG の役割で 2 ディレクトリに分ける。ユーザー設定とプロジェクトデータは `~/.config/gozd/`、
「前回の続き」を表す state は `~/.local/state/gozd/`。

```text
~/.local/state/gozd/
├── app-state.json          # sidebar の構成 / 折りたたみ / worktree 一覧キャッシュ / 最後の選択
└── electron-window.json    # ウィンドウの位置とサイズ

~/.config/gozd/
├── config.json             # グローバルなユーザー設定
└── projects/
    └── <projectKey>/       # <repoName>-<realpath の SHA-256 先頭 12 文字>
        ├── tasks.json      # Task 一覧
        └── config.json     # プロジェクト固有設定
```

> [!WARNING]
> 永続ファイルへの cross-process ロックは持たない。複数インスタンスを同時起動して同じファイルを
> 触ると、最後に保存したプロセスが他方の変更を上書きする（last-write-wins を許容する設計判断）。

### 保存の契約

- **保存は全フィールドを明示的に書く**。読み出し側は欠落キーを default で埋める（「フィールド不在 =
  default」を永続ファイルの契約として維持する）
- **未知の top-level キーは保持する**。別バージョンが書いたフィールドを消さない
- **parse に失敗した state ファイルは初期状態で上書きする**（後方互換を作らない規約）。
  ログを残して観察可能性を保つ

### 保存タイミング

| データ         | タイミング         |
| -------------- | ------------------ |
| アプリ状態     | アプリ終了時の一括 |
| ウィンドウ位置 | ウィンドウの close |
| Task           | 操作の都度即時     |
| ユーザー設定   | 操作の都度即時     |

## Claude Code hooks

Claude Code の hooks 機能でエージェントの状態変化を受け取る。設定ファイルはアプリ起動時に生成し、
zsh init が注入する。

### イベントと送信経路

| Claude hook          | gozd イベント    | 送信経路 | 取得データ                                                             |
| -------------------- | ---------------- | -------- | ---------------------------------------------------------------------- |
| `SessionStart`       | `session-start`  | CLI      | `ptyId`, `session_id`, `source`                                        |
| `SessionEnd`         | `session-end`    | CLI      | `ptyId`, `session_id`                                                  |
| `UserPromptSubmit`   | `running`        | 直接送信 | `ptyId`                                                                |
| `Stop`               | `done`           | CLI      | `ptyId`, `last_assistant_message`, `pending_work`, `has_teammate_task` |
| `PermissionRequest`  | `needs-input`    | CLI      | `ptyId`, `tool_name`, `tool_input`                                     |
| `PostToolUse`        | `tool-done`      | 直接送信 | `ptyId`                                                                |
| `PostToolUseFailure` | `tool-failure`   | 直接送信 | `ptyId`                                                                |
| `StopFailure`        | `stop-failure`   | CLI      | `ptyId`, `last_assistant_message`                                      |
| `SubagentStart`      | `subagent-start` | CLI      | `ptyId`, `agent_id`                                                    |
| `SubagentStop`       | `subagent-stop`  | CLI      | `ptyId`, `agent_id`                                                    |
| `TeammateIdle`       | `teammate-idle`  | CLI      | `ptyId`, `teammate_name`                                               |

### 送信経路の使い分け

- **直接送信**: 固定 JSON を 1 行送るだけ。軽量だが stdin のデータを取れない。発火頻度が高く
  payload が要らないイベントに使う
- **CLI 経由**: stdin の JSON を parse して payload にマージする。Claude Code が渡す詳細データを
  UI まで届けたいイベントに使う

状態の解釈は [claude-status.md](claude-status.md)。
