# Git / GitHub

gozd の git / gh 連携を担う層のドキュメント。データ取得経路、更新トリガー、エラーハンドリング、設計上のトレードオフをまとめる。

ファイル監視そのものの基盤については [architecture.md](architecture.md) の「SSOT push の dir filter 規律」「FSWatch の対象スコープ」セクションを参照。

## 設計原則

- **local refs / ファイルの変化は SSOT push (FSEvents) で取る**。push 経路で取れる情報を polling でも取る二重経路は予防的逃げ道として禁止する
- **local refs を動かさない GitHub mutation (`gh pr create` (既 push) / `gh pr edit` / `gh pr comment` 等) は polling で取る**。push 経路では原理的に到達不能なため、scope を active worktree 1 個に絞った 60 秒 polling が **唯一の正規経路**。`gh pr list` のみが対象 (全 worktree fan-out にはしない)
- gh (GitHub API) の呼び出しは **必要最小限**。session 中に冪等な情報 (viewer / repo owner) は memoize / local 取得で gh コール自体を回避する
- gh 失敗は **silent drop 禁止**。原因種別ごとに分類してトースト通知し、rate limit 枯渇を観察可能性から消さない

## RPC 一覧

すべて `apps/native/Sources/GozdCore/GitOps.swift` / `GitHubOps.swift` で実装され、`apps/renderer/src/features/*/rpc.ts` から呼ばれる。

### git (local プロセス起動)

| RPC                     | 用途                                   | 呼ばれる場面                                                 |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `rpcGitStatus`          | working tree status + HEAD + upstream  | 初回 load、`gitStatusChange` push 後の再 fetch               |
| `rpcGitLog`             | commit graph 用の log                  | GitGraphPane 初回 load、`branchChange` / `fsWatchReady`      |
| `rpcGitWorktreeList`    | worktree 一覧                          | サイドバー初回 load、`worktreeChange` push 後                |
| `rpcGitDefaultBranch`   | デフォルトブランチ名                   | worktree 作成 dialog の初期値                                |
| `rpcGitShowFile`        | HEAD 時点のファイル内容                | PreviewPane の diff 表示                                     |
| `rpcGitShowCommitFile`  | 指定 commit でのファイル内容           | GitGraph commit 詳細 → diff                                  |
| `rpcGitLsTree`          | 指定 commit の tree から 1 階層列挙    | Filer snapshot mode の lazy expand                           |
| `rpcGitDiffHunks`       | 2 テキスト間の hunk 単位差分           | DiffPreview。`git diff --no-index` で計算 SSOT を git に置く |
| `rpcGitDiffExpandLines` | hunk-bar クリックで unchanged 行を展開 | DiffPreview の hunk-bar クリック                             |
| `rpcGitBlameLine`       | 1 行の `git blame --porcelain`         | CodePreview / DiffPreview の行番号クリック (BlamePopover)    |
| `rpcGitLogLine`         | 1 行の変更履歴 (`git log -L`)          | BlamePopover の "View line history" タブ                     |
| `rpcGitCommitFiles`     | `git add` + `git commit`               | ChangesPane の commit ボタン                                 |
| `rpcGitFetchRemotes`    | `git fetch --all` (全 remote)          | ユーザー操作 / fetch ボタン                                  |
| `rpcCreateWorktree`     | `git worktree add` 相当                | worktree 作成 dialog の OK ボタン                            |
| `rpcGitWorktreeRemove`  | `git worktree remove` 相当             | worktree 削除メニュー                                        |

### gh (GitHub API 経由)

| RPC               | 用途                           | 呼ばれる場面                      |
| ----------------- | ------------------------------ | --------------------------------- |
| `rpcGitPrList`    | PR 一覧 (GraphQL)              | PR picker (`cmd+P` 等) 起動時     |
| `rpcGitIssueList` | Issue 一覧 (GraphQL)           | Issue picker 起動時               |
| `rpcGitViewer`    | 認証ユーザー名 (`gh api user`) | `useViewer` cache が空のとき 1 回 |

`gh repo view` 経路は廃止済み。owner / repo は `git config --get remote.origin.url` の local parse (`parseGitHubOwnerRepo`) で取得する。`github.com` host のみ受理。

## push 経路 (native → renderer)

すべて FSEvents 経由で発火し、payload に `dir` を必須で持つ ([architecture.md](architecture.md#ssot-push-の-dir-filter-規律))。

| push event         | 発火源                                                                                           | 主な subscriber                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fsChange`         | worktree 内ファイルの変更                                                                        | FilerPane (active dir のみ)                                                                                                                        |
| `gitStatusChange`  | per-wt の `index` / HEAD、common の `refs/remotes/*` / `packed-refs`、作業ツリー側のファイル変更 | useGitStatusSync (全 worktree の ahead/behind 反映)、FilerPane / GitGraphPane (active の HEAD / branchHead / upstream 変化で `loadLog`)            |
| `branchChange`     | `refs/heads/*` / `packed-refs`                                                                   | GitGraphPane (同 repo の active で `loadLog`)、useSidebarData (source dir の repo を refetch)                                                      |
| `remoteRefsChange` | `refs/remotes/*` / `packed-refs` (push / fetch 後)                                               | GitGraphPane (同 repo の active で `loadLog`。current 以外の remote ref 動きは `gitStatusChange` の upstream key では検知できないため、ここで補完) |
| `worktreeChange`   | `worktrees/*` 配下                                                                               | useSidebarData (source dir の repo)                                                                                                                |
| `fsWatchReady`     | `rpcFsWatch` 成功直後の re-sync シグナル                                                         | GitGraphPane (active)、useSidebarData (source dir)                                                                                                 |

### primary watcher dedup

同じ commonGitDir を共有する N 個の worktree watcher で `refs/heads/*` のような共有領域の event が起きると、N 重発火する。`FSWatchRegistry` は main worktree (`perWorktreeGitDir == commonGitDir`) を primary に固定し、その 1 つだけに `branchChange` / `remoteRefsChange` / `worktreeChange` の dispatch を collapse する (旧設計の「lex 最小」は worktree clone で wt path が main より lex 小のとき primary を奪い、`worktrees/<name>/` 削除を分類できない死角を生んだため廃止)。

- `gitStatusChange` は per-worktree の ahead/behind を返すため dedup しない (各 worktree で値が異なる)
- 非 git project (`commonGitDir == nil`) では `branchChange` / `remoteRefsChange` / `worktreeChange` 自体が発火しない

### `refs/remotes/*` / `packed-refs` の多重発火と `scheduleLoadLog` の coalescing

`refs/remotes/*` は `gitStatusChange` + `remoteRefsChange` の **両方** を発火する。`packed-refs` は `branchChange` + `gitStatusChange` + `remoteRefsChange` の **3 つ** を発火する。これにより、active worktree の current branch を `git push` した場合、GitGraphPane の handler が短時間に 2〜3 回 `loadLog` を要求する状況が生じる。

各 push の責務を分けることで「current branch 以外の remote ref が動いたとき git log が再 load されない」取りこぼしを構造的に防ぐ。詳細は [SSOT push の dir filter 規律](architecture.md#ssot-push-の-dir-filter-規律) を参照。

GitGraphPane 側の防衛は 2 段構え:

- **`scheduleLoadLog` (事前防衛)**: push 由来 handler (`branchChange` / `remoteRefsChange` / `fsWatchReady` / `gitStatusChange` の scroll 不要経路) はこれを呼ぶ。`loadLogInFlightCount > 0` なら 1 bit の pending flag に畳み、`count === 0` に落ちた時点で trailing 1 fetch を発射する。burst N 発火を最大 2 fetch (in-flight + trailing) に集約する
- **counter で coalesce target を統一**: 明示 trigger 由来の `await loadLog()` (worktree 切替 / firstParentOnly / `headChanged` 経路) も同じ `loadLogInFlightCount` を立てる。よって明示 trigger が走っている間に届く burst 由来 push も pending に畳まれる (片方向ではなく双方向の集約)
- **`loadLogGen` (事後防衛)**: 並走する `loadLog` が複数完了したときの最終結果を世代管理で 1 つに収束させる。`scheduleLoadLog` でも交錯で 2 fetch を超えた場合の保険として機能する

## 更新トリガー

「いつ何が更新されるか」のユーザー観点まとめ。すべて event-driven。

### 即時反映される (local event 起点)

| ユーザー操作                       | 経路                                   | 反映先                                       |
| ---------------------------------- | -------------------------------------- | -------------------------------------------- |
| ファイル編集 / 追加 / 削除         | `fsChange`                             | FilerPane                                    |
| `git add` / `git restore` 等       | `gitStatusChange`                      | git status 色分け、ChangesPane               |
| `git commit`                       | `gitStatusChange` + `branchChange`     | GitGraphPane (`loadLog`)、PR list 等         |
| `git checkout` / `git switch`      | `gitStatusChange` + `branchChange`     | active branch 表示、GitGraphPane             |
| `git branch -m` (rename)           | `branchChange` (HEAD OID 不変)         | GitGraphPane (`branchHead` 変化で発火)       |
| `git fetch`                        | `gitStatusChange` + `remoteRefsChange` | GitGraphPane (`loadLog`)、ahead/behind       |
| `git push`                         | `gitStatusChange` + `remoteRefsChange` | ahead/behind、GitGraphPane                   |
| `git worktree add` / `remove`      | `worktreeChange`                       | サイドバー worktree 一覧                     |
| 別 worktree / 別 repo での同種操作 | 上記すべて (全 worktree watch)         | 該当する pane (dir filter で振り分け)        |
| worktree 切替                      | UI 操作                                | 切替対象 dir の初回 load                     |
| PR / Issue picker 起動             | UI 操作                                | 起動時に `gh pr list` / `gh issue list` 1 回 |

### local refs を動かさない GitHub mutation

`gh pr create` (既 push 済み branch) / `gh pr edit` / `gh pr comment` / `gh pr review` / `gh pr ready` / `gh pr merge` / `gh issue create` / `gh issue edit` / `gh issue comment` 等は local refs / ファイルが変化しないため SSOT push が発火しない。他人 / CI による GitHub サーバ側の変化 (PR コメント / 新規 PR / 他人による merge / CI status) も同様。

gozd の primary use case は **「Claude / ユーザーが worktree で並列に `gh pr create` する」** ことであり、上記の中でも特に `gh pr create` (既 push) は中核の操作。これを反映する経路として **active worktree 1 個に対する 60 秒間隔の `gh pr list` polling** が GitGraphPane に組み込まれている。

scope は active worktree 1 個に限定するため負荷は 60 query/h (GH GraphQL 5000/h の 1.2%)。全 worktree fan-out にはしない。

### `loadPrList` の発火条件 (GitGraphPane)

| 発火元                      | 場面                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `onMounted`                 | GitGraphPane マウント時                                                    |
| `watch(worktreeStore.dir)`  | worktree 切替時 (interval も再スタート)                                    |
| `remoteRefsChange`          | push / fetch で remote ref が動いたとき (current 以外の branch 動きも含む) |
| `useIntervalFn` (60 秒間隔) | active worktree に対する定期取得                                           |

`gitStatusChange.upstreamChanged` 側では `loadPrList` を呼ばない。`# branch.ab` の数値変化のうち、`headChanged` でない経路は構造的に `refs/remotes/origin/<current-branch>` の書き換えに対応し、その場合は必ず `remoteRefsChange` も同じ burst で発射されるため、`gitStatusChange` 側で呼ぶと `gh pr list` が 2 連射される。`branchChange` / `fsWatchReady` は graph 再描画のみで PR list を取り直さない。

例外: `git branch --set-upstream-to` / `--unset-upstream` で `.git/config` だけが書き換わる経路は FSEvents の射程外 (refs を動かさない) で classify が silent drop する。後段の何か別 trigger で `gitStatusChange` が再発火したとき `upstreamChanged` 単独経路に流れて `loadPrList` が呼ばれないが、60s polling で吸収する想定。upstream 設定変更は gozd の primary use case (Claude が `gh pr create` する流れ) では低頻度の操作で、運用影響は限定的。

picker 経由は独立: PR picker 起動ごとに `rpcGitPrList` が 1 回走る。

## viewer の session-scope memoize

`useViewer.ts` (module singleton + lazy + in-flight share):

- 戻り値は `Promise<string | undefined>`。成功 / 失敗を型で区別
- session 中に 1 回成功すれば cache を返し続ける (PR picker / Issue picker を何度開いても `gh api user` は再発射しない)
- 失敗時は cache に書き込まないため次回 retry 可能
- `viewer !== ""` UI 契約を保つため、registration 境界で `?? ""` 変換する

> [!WARNING]
> CLI 再認証 / account 切替時には stale になる。session 中ほぼ不変という設計上のトレードオフとして受け入れている。

## gh エラー分類

silent drop / 一律 nil 化は rate limit 枯渇を観察可能性から消すため禁止。Swift 側で stderr を分類し、proto enum `GhErrorKind` で renderer に返す。

### 分類 (`classifyGhStderr` in `apps/native/Sources/GozdCore/GitHubOps.swift`)

| GhErrorKind       | stderr パターン                        | renderer 文言                                                  |
| ----------------- | -------------------------------------- | -------------------------------------------------------------- |
| `RATE_LIMIT`      | `API rate limit exceeded` 等           | `${action}: GitHub API rate limit exhausted`                   |
| `UNAUTHENTICATED` | `not logged into` / `gh auth login`    | `${action}: gh CLI is not authenticated (run 'gh auth login')` |
| `REPO_NOT_FOUND`  | `Could not resolve to a Repository` 等 | `${action}: repository not found or no access`                 |
| `NETWORK`         | `dial tcp` / `connection refused` 等   | `${action}: network error reaching GitHub`                     |
| `OTHER`           | 上記いずれにも該当しない               | `${action}: gh CLI failed`                                     |

renderer 側は `ghErrorMessage(kind, action)` で文言を組み立て、`notify.error` でトースト通知する。`apps/renderer/src/features/palette/features/pr-picker/ghError.ts` を参照。

### 設計判断

- `runGhOrNilOnCommandFailure` (全失敗 nil 一律化) は廃止。`runGhCategorized` で分類して上位に返す
- PR の fork 判定に使っていた GraphQL `repository.owner.login` は廃止し、local `parseGitHubOwnerRepo` の owner と比較する

## 観察可能性

- `pushToRenderer` ヘルパー (`apps/native/Sources/Gozd/GozdApp.swift`) は失敗時に stderr に `[GozdApp] push failed: type=...` を必ず出力する (silent drop 禁止)
- gh 失敗は分類ごとに区別された文言でトースト通知する。同じ文言で全失敗を吸収しない
- rate limit の実測は `gh api rate_limit` で確認できる (`graphql.remaining` / `core.remaining`)

## 関連ドキュメント

- [architecture.md](architecture.md) — 全体の通信経路、SSOT push の dir filter 規律、FSWatch のスコープ
- [workspace.md](workspace.md) — マルチ repo / マルチ worktree の運用
- [rpc.md](rpc.md) — RPC スキーマの proto 定義
