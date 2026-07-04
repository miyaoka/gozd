# サーバー検出（実行中サーバーの可視化）

複数 repo・複数 worktree で並列開発するとき、各 worktree のターミナルで dev server（Vite 等）が
同時に立ち上がる。「どの port をどこ（どの repo / worktree / ターミナル）が掴んでいるか」を
可視化し、port 競合の調査を支援する（issue #768）。

## 検出方式

macOS にはソケットの LISTEN 開始を通知する event API が存在しないため、**ポーリング**で検出する
設計（FSEvents のような event-driven な経路は使えない）。

現実装（`apps/electron/src/serverList.ts`）は `lsof -nP -iTCP -sTCP:LISTEN` の**単発走査**で、
renderer mount 時の `/server/list` pull hydrate のみ対応する。lsof は該当なしで exit 1 を返す
ため、その場合のみ空扱いにする。

> [!NOTE]
> lsof で検出できるのは実質「現在ユーザー所有プロセスの LISTEN ソケット」。dev server は基本
> ユーザー所有なので port 競合調査の主目的には十分。対象は TCP のみ（UDP / Unix domain socket は
> dev server 用途では不要）。
>
> Swift 期は libproc ベースの `PortScanner` が数秒間隔の周期走査 + 差分 push（`serverPortsChange`）
> と PTY 子孫判定による帰属を持っていた。Electron 版の周期走査 / 帰属は未移植の縮退（下の
> 「帰属」表は設計契約として残す）。

## 帰属（attribution）

各 LISTEN プロセスの ppid チェーンを辿り、祖先が gozd PTY の子プロセスなら当該 worktree に
帰属させる設計。dev server（node 等）は PTY 直下の shell の子孫なので、ancestry walk で必ず
PTY shell に到達する。CWD ではなくプロセス親子関係で判定するため、サブディレクトリで起動した
サーバーも正しく帰属する。**現実装は全件 `external` を返す縮退状態**（帰属判定は未移植）。

| 種別       | 条件                                                                        | 表示                         |
| ---------- | --------------------------------------------------------------------------- | ---------------------------- |
| `live`     | 生きている PTY の子孫                                                       | worktree バッジ + パネル     |
| `orphaned` | 過去に live 帰属したが PTY は消滅（端末/worktree を閉じた後も port を掴む） | パネルのみ（「閉じた端末」） |
| `external` | gozd 外のプロセス                                                           | パネルのみ（「gozd 外」）    |

orphaned 検出のため、一度 live 帰属した pid → worktreePath を記憶する設計（PTY 消滅後に親が
launchd へ付け替わっても、記憶から最後の帰属先を引いて orphaned として表示する）。

## 配送経路

「mount で pull、変化で push」の確立パターンに従う設計。現実装は pull のみ:

- **pull**: renderer mount 時に `/server/list` RPC で snapshot を hydrate する（リロード後の
  再水和も担う）
- **push**（`serverPortsChange`、差分があった scan でのみ発射）は周期走査とセットで未移植

wire shape は `packages/proto/gozd/v1/server.proto` の `ServerEntry` が SSOT。renderer は
feature 内部型 `ServerInfo` に正規化する（`apps/renderer/src/features/server/rpc.ts`）。

## UI

- **worktree バッジ**（`WtCard.vue`）: その worktree で LISTEN 中の port を Claude status バッジと同粒度で
  ヘッダに表示する（live のみ。orphaned はその worktree の現役サーバーではないので含めない）
- **一覧パネル**（`ServerListPanel.vue`）: 右ドック型オーバーレイ。
  各サーバーを **port 単位の行**に展開して port 昇順で並べる。同一 port が複数行に跨るときは衝突候補
  として警告色で示す。行クリックで該当 worktree を active にし、live なら端末ペインへフォーカスする
  （external はクリック不可）。ターミナルを見ながら調べる用途のため背景は覆わず、ESC / 閉じるボタンで閉じる

## 開閉状態の所有

パネルの開閉状態は renderer（`useServerStore.isOpen`）が SSOT として所有する。Swift 期は native
titlebar のトグルボタンに active 表示をミラーしていたが、Electron shell は native toolbar を
持たないため `/window/setServerPanelOpen` RPC は受理のみ（縮退）。
