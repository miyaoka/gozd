# Git / GitHub

git / GitHub 連携の更新契約。何がいつ更新されるか、どこまで取りに行くか、失敗をどう見せるか。

監視基盤そのものは [architecture.md](architecture.md) の「SSOT push の dir filter 規律」
「ファイル監視」を参照。

## 設計原則

- **git / gh の実行バイナリはユーザーのログインシェル経由で解決する**。Finder / Dock から起動した
  アプリは最小の PATH しか継承せず、PATH 解決では OS 同梱の git に倒れる。macOS の Keychain ACL は
  バイナリ単位のため、ターミナルと別バイナリの credential helper が keychain に触ると認証ダイアログが
  出る。**解決に失敗しても既定パスへ silent fallback しない** — fallback は同じ非対称を黙って
  再導入する
- **local な参照とファイルの変化は push で取る**。push で取れる情報を polling でも取る二重経路は、
  予防的な逃げ道として禁止する
- **local な参照を動かさない GitHub 側の変更だけ polling で取る**。push では原理的に到達できない
  ため、これが唯一の正規経路
- **GitHub API の呼び出しは必要最小限**。セッション中に変わらない情報は 1 度だけ取得するか local から
  得て、API 呼び出し自体を避ける
- **GitHub 由来の失敗を silent drop しない**。原因種別ごとに分類して通知し、rate limit の枯渇を
  観察可能性から消さない

## push 経路

すべてファイル監視から発火し、payload に発火源の `dir` を持つ。

| push event         | 発火源                                                     | 主な購読者                          |
| ------------------ | ---------------------------------------------------------- | ----------------------------------- |
| `fsChange`         | worktree 内のファイル変更                                  | ファイルツリー（active dir のみ）   |
| `gitStatusChange`  | worktree の index / HEAD、共有の参照領域、作業ツリーの変更 | ahead / behind 表示、ツリー、グラフ |
| `branchChange`     | ローカルブランチ参照の変化                                 | グラフ、サイドバー                  |
| `remoteRefsChange` | リモート tracking 参照の変化（push / fetch 後）            | グラフ、PR 一覧の再取得             |
| `worktreeChange`   | worktree の追加削除、main worktree の checkout 先変化      | サイドバーの worktree 一覧          |
| `fsWatchReady`     | 監視登録が成立した直後の再同期シグナル                     | グラフ、サイドバー                  |

`remoteRefsChange` を `gitStatusChange` と別に持つのは、**current branch 以外の remote 参照が
動いたときを status の upstream 情報では検知できない**ため。各 push の責務を分けることで
取りこぼしを構造的に防ぐ。

### ref backend に依存しない分類

git の ref backend は複数あり、物理レイアウトが異なる。**監視で拾えるのは「どの ref store が動いた
可能性があるか」という候補まで**で、実際に何が動いたかは backend に依存しない問い合わせ結果の
ダイジェストを前回値と比較して確定する。物理レイアウトの allowlist を焼き込まない。

ダイジェストは 3 カテゴリを持つ。

| カテゴリ      | 変化する操作                                           | 発火する push      |
| ------------- | ------------------------------------------------------ | ------------------ |
| ローカル参照  | commit / branch の作成・削除・rename                   | `branchChange`     |
| リモート参照  | push / fetch                                           | `remoteRefsChange` |
| HEAD の指す先 | **branch 切替**（commit では不変。参照先は変わらない） | `worktreeChange`   |

backend によって branch 切替の物理的な現れ方が違う。片方では worktree ごとの HEAD ファイルが動き、
もう片方では HEAD が固定スタブのまま共有テーブルだけが書き換わる。**後者では HEAD の内容比較だけが
main worktree の branch 切替を捕捉できる唯一の経路**になるため、この問い合わせを backend 判定の外に
置く。

### 共有領域の多重発火を畳む

同じ git ディレクトリを共有する N 個の worktree 監視は、共有領域の変化で N 重に発火する。

- **共有領域由来の push は main worktree の監視 1 つに集約する**。集約先を「共有 git ディレクトリと
  一致する worktree」で決めるのは、辞書順のような相対比較だと worktree の配置次第で集約先が
  入れ替わり、worktree の構成変化を分類できない死角が生まれるため
- **worktree ごとに値が異なる `gitStatusChange` は集約しない**。ahead / behind は worktree 単位の
  値なので、全監視で発火させる
- 非 git のディレクトリでは共有領域由来の push 自体が発火しない

### 内容が変わらない push を落とす

dir ごとに直近 push した status を保持し、**新たに算出した値が完全一致するなら push しない**。

git ディレクトリ外の変更は untracked や差分の可能性があるため一律 `gitStatusChange` に分類するが、
ビルド成果物のように ignore 対象なら `git status` の出力は変わらない。typecheck やビルド中は
この「内容不変の push」が連射され、購読側の再描画が続く。

- 比較対象には **変更ファイルの最終更新時刻も含める**。既存の差分ファイルを再保存しただけの
  ケースで表示上の日時を更新する必要があるため
- ignore 対象のファイルは status に現れないので時刻集計の対象外。上のビルド連射の抑止を壊さない
- 各 worktree が独立したキャッシュを持つため、集約とは直交する。最初の status と監視の張り直し後は
  無条件で push する

### 購読側が満たすこと

同一の操作が複数の push を発火する（例: push すると status とリモート参照の両方が動く）。
購読側はこれを畳む責務を持つ。

- **burst の途中で取得を積み増さない**。取得が進行中の間に届いた要求はまとめ、進行中が無くなった
  時点で 1 回だけ取り直す。明示操作由来の取得も同じ集約に乗せる（**片方向でなく双方向**）
- **並走した取得が複数完了しても、最終結果は 1 つに収束する**

## 更新トリガー

すべて event-driven。

| ユーザー操作                       | 反映先                                 |
| ---------------------------------- | -------------------------------------- |
| ファイル編集 / 追加 / 削除         | ファイルツリー                         |
| `git add` / `git restore` 等       | status の色分け、変更一覧              |
| `git commit`                       | グラフ                                 |
| `git switch`（既存 branch）        | サイドバーの branch 表示、グラフ       |
| `git branch -m`（rename）          | グラフ（HEAD の commit は不変）        |
| `git fetch` / `git push`           | グラフ、ahead / behind                 |
| `git worktree add` / `remove`      | サイドバーの worktree 一覧             |
| 別 worktree / 別 repo での同種操作 | 該当する pane（dir filter で振り分け） |
| worktree 切替                      | 切替先 dir の初回取得                  |
| PR / Issue picker 起動             | 起動時に 1 回だけ一覧を取得            |

### local な参照を動かさない GitHub 側の変更

`gh pr create`（push 済み branch）/ `gh pr edit` / `gh pr comment` / `gh pr merge` などは local な
参照もファイルも動かさないため、push が発火しない。他人や CI による GitHub 側の変化も同じ。

gozd の中核的な使い方は「worktree で並列に PR を作る」ことなので、これを反映する経路が要る。
**active な worktree 1 個を対象にした 60 秒間隔の PR 一覧取得**が唯一の polling で、全 worktree への
fan-out はしない。

**ウィンドウのフォーカスを可視性の一部として扱う**。blur 中はユーザーが見ていないので対象を空にして
撃たず、focus 復帰は「対象の出入り」として自然に catch-up する（focus 専用の発火トリガを持たない）。
負荷の上限は focus 時で active な repo 1 個あたり 60 query/h、blur 中は 0。

### PR 一覧が運ぶ情報の範囲

PR 一覧は polling で繰り返し取得するため、**GitHub API の消費が PR 件数に比例して増えない形に
保つ**。一覧に載せてよいのは、PR 1 件あたりの追加の往復なしに取得できる情報だけとする。個々の
チェックの内訳やレビューの中身のように PR ごとの往復を要する情報は一覧に載せず、必要になった
時点で対象を 1 件に絞って取得する。

この範囲で一覧が運ぶのは、PR の識別と、一覧を眺めて状況を掴める程度の要約（CI の総合結果、
会話の総量など）までとする。要約は累積値であって、未読や残作業の数ではない。解決済みかどうかの
区別は個々の項目を辿らないと得られず、上の制約に反する。

**得られなかった要約は描かない。** 欠けた要約だけを出さないのであって、PR そのものは一覧に出る。
「不明」を表す専用の見た目を持たない — polling で更新され続ける値なので、欠落を状態として描くと
実体のない情報が画面に定着する。

### PR 一覧のキャッシュ契約

PR 一覧は repo 単位で結果が同じなので、**repo 単位でキャッシュする**。

- **repo 単位の freshness lock**: 成否を問わず取得後 60 秒は再取得しない。worktree を頻繁に
  切り替えても、同じ repo を撃ち直さない
- **表示は active な repo のキャッシュを直接導出する**。別の ref にミラーしない — ミラーすると
  SSOT が二重化し、正しさが特定のコンポーネントの mount 状態に結びつく
- **repo 切替時にキャッシュを消さない**。別 repo の PR が混ざる事故は repo 単位のキー分離で
  構造的に起きないため、切替直後もキャッシュを即座に表示できる
- **後着の応答は repo 単位のキーへ書く**。切替と取得が重なっても cross-repo の汚染は起きない

発火元:

| 発火元             | 場面                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| 対象の出入り       | repo 切替 / focus 復帰・喪失。同一 repo 内の worktree 切替では発火しない |
| 60 秒間隔          | active な repo の定期取得。blur 中は対象が無く no-op                     |
| `remoteRefsChange` | push / fetch でリモート参照が動いたとき。同 repo の active のみ          |

`gitStatusChange` からは PR 一覧を取り直さない。upstream の数値変化は必ず同じ burst で
`remoteRefsChange` も発射するため、両方から呼ぶ必要がない。

> [!NOTE]
> upstream 設定の変更（`git branch --set-upstream-to` 等）は参照を動かさず設定ファイルだけが
> 変わるため、監視の分類では拾えない。60 秒間隔の取得が吸収する。

### セッション内で不変な情報

GitHub の認証ユーザーのような、セッション中ほぼ不変な情報は 1 回の成功をキャッシュして返し続ける。
失敗はキャッシュせず次回リトライできる。

> [!WARNING]
> CLI の再認証やアカウント切替では stale になる。セッション中ほぼ不変という前提のトレードオフ
> として受け入れる。

## GitHub 由来のエラー分類

一律で「失敗」に畳むと rate limit の枯渇が観察可能性から消える。main 側で原因を分類し、
文字列リテラル union で renderer に返す。

| 種別              | 意味                             |
| ----------------- | -------------------------------- |
| `RATE_LIMIT`      | API の rate limit 枯渇           |
| `UNAUTHENTICATED` | CLI が未認証                     |
| `REPO_NOT_FOUND`  | リポジトリが存在しないか権限なし |
| `NETWORK`         | GitHub へ到達できない            |
| `OTHER`           | 上記以外                         |

renderer は種別と操作名から文言を組み立ててトースト通知する。**同じ文言で全失敗を吸収しない**。

## 観察可能性

- renderer の再構築中に落ちた push は、mount 時の pull と購読の貼り直しで回復する
- GitHub 由来の失敗は分類ごとに区別された文言で通知する
- rate limit の実測は `gh api rate_limit` で確認できる

## 関連ドキュメント

- [architecture.md](architecture.md) — 通信経路、push の filter 規律、監視スコープ
- [workspace.md](workspace.md) — マルチ repo / マルチ worktree の運用
- [rpc.md](rpc.md) — 型の SSOT とメッセージ一覧
