# サーバー検出（実行中サーバーの可視化）

複数 repo・複数 worktree で並列開発するとき、各 worktree のターミナルで dev server（Vite 等）が
同時に立ち上がる。「どの port をどこ（どの repo / worktree / ターミナル）が掴んでいるか」を
可視化し、port 競合の調査を支援する（issue #768）。

## 検出方式

macOS にはソケットの LISTEN 開始を通知する event API が存在しないため、**ポーリング**で検出する。
FSEvents のような event-driven な経路は使えない。

`PortScanner`（`apps/native/Sources/GozdCore/PortScanner.swift`、actor）が数秒間隔で全プロセスの
TCP LISTEN ソケットを走査する。実体は `CProc` C bridge（`apps/native/Sources/CProc/`）で、libproc
を呼ぶ:

- `proc_listpids(PROC_ALL_PIDS)` で全 pid を列挙
- `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)` で各 fd の socket 情報を取り、`SOCKINFO_TCP` かつ
  `TSI_S_LISTEN` のものの local port を拾う
- `proc_pidinfo(PROC_PIDTBSDINFO)` で各 pid の ppid / プロセス名を取る

`lsof` の周期 spawn は遅く権限問題もあるため使わない。libproc を C bridge に隔離する理由は
`socket_fdinfo` が C union を多用し Swift から触ると煩雑なため（必要な pid / port / ppid / name
だけを C 側で抽出して plain struct で返す）。

> [!NOTE]
> `proc_pidfdinfo` / `PROC_PIDLISTFDS` は他ユーザー所有プロセスに対し EPERM を返す。検出できるのは
> 実質「現在ユーザー所有プロセスの LISTEN ソケット」。dev server は基本ユーザー所有なので port 競合
> 調査の主目的には十分。EPERM のプロセスは skip して走査を継続する。
>
> 対象は TCP のみ。UDP / Unix domain socket は dev server 用途では不要なため対象外。IPv4 / IPv6 は
> 両方検出され、`Set<port>` で pid 単位に集約するため重複は潰れる（bind アドレスの区別はしない）。

## 帰属（attribution）

各 LISTEN プロセスの ppid チェーンを辿り、祖先が gozd PTY の子プロセス（`PTYRegistry.childPidMap()`）
なら当該 worktree に帰属させる。dev server（node 等）は PTY 直下の shell の子孫なので、ancestry walk
で必ず PTY shell に到達する。CWD ではなくプロセス親子関係で判定するため、サブディレクトリで起動した
サーバーも正しく帰属する。

| 種別       | 条件                                                                        | 表示                         |
| ---------- | --------------------------------------------------------------------------- | ---------------------------- |
| `live`     | 生きている PTY の子孫                                                       | worktree バッジ + パネル     |
| `orphaned` | 過去に live 帰属したが PTY は消滅（端末/worktree を閉じた後も port を掴む） | パネルのみ（「閉じた端末」） |
| `external` | gozd 外のプロセス                                                           | パネルのみ（「gozd 外」）    |

orphaned 検出のため、一度 live 帰属した pid → worktreePath を `PortScanner` が記憶する。PTY 消滅後に
親が launchd（ppid=1）へ付け替わっても、記憶から最後の帰属先を引いて orphaned として表示する。
記憶はプロセス消滅時に scan 末尾で掃除するため無制限には伸びない。

## 配送経路

「mount で pull、変化で push」の確立パターンに従う。

- **push**: `PortScanner` が前回 snapshot と差分があった scan でのみ `serverPortsChange` を発射する
  （全件 snapshot、差分ではない）。renderer 側は latest-wins で置換する
- **pull**: renderer mount 時に `/server/list` RPC で直近 snapshot を hydrate する（HMR リロード後の
  再水和も担う）

wire shape は `packages/proto/gozd/v1/server.proto` の `ServerEntry` が SSOT。push は AppRuntime が
手組み dict で送り（attribution は文字列）、pull は proto enum で返す。renderer は両経路を feature 内部
型 `ServerInfo` に正規化する（`apps/renderer/src/features/server/rpc.ts`）。

```text
PortScanner (scan, 差分判定)
  → onServerPortsChange callback (AppRuntime)
  → pushToRenderer("serverPortsChange", { servers: [...] })
  → useServerStore: servers を latest-wins 置換
  → WtCard バッジ / ServerListPanel テーブル
```

## UI

- **worktree バッジ**（`WtCard.vue`）: その worktree で LISTEN 中の port を Claude status バッジと同粒度で
  ヘッダに表示する（live のみ。orphaned はその worktree の現役サーバーではないので含めない）
- **一覧パネル**（`ServerListPanel.vue`）: native titlebar のトグルボタンから開く右ドック型オーバーレイ。
  各サーバーを **port 単位の行**に展開して port 昇順で並べる。同一 port が複数行に跨るときは衝突候補
  として警告色で示す。行クリックで該当 worktree を active にし、live なら端末ペインへフォーカスする
  （external はクリック不可）。ターミナルを見ながら調べる用途のため背景は覆わず、ESC / 閉じるボタンで閉じる

## titlebar トグルの状態ミラー

パネルの開閉状態は renderer（`useServerStore.isOpen`）が SSOT として所有する。native titlebar の
`ToolbarItem`（`GozdApp.swift`）はクリックで `toggleServerPanel` push を投げるだけで、開閉状態は持たない。
`isOpen` の変化を `/window/setServerPanelOpen` RPC で `ServerPanelContext`（`@Observable`）にミラーし、
ボタンの active 表示（塗り）を同期する。TitleContext と同じ「renderer 所有 → native 表示ミラー」の流儀。
