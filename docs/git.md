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

| RPC                    | 用途                                  | 呼ばれる場面                                                 |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `rpcGitStatus`         | working tree status + HEAD + upstream | 初回 load、`gitStatusChange` push 後の再 fetch               |
| `rpcGitLog`            | commit graph 用の log                 | GitGraphPane 初回 load、`branchChange` / `fsWatchReady`      |
| `rpcGitWorktreeList`   | worktree 一覧                         | サイドバー初回 load、`worktreeChange` push 後                |
| `rpcGitDefaultBranch`  | デフォルトブランチ名                  | worktree 作成 dialog の初期値                                |
| `rpcGitShowFile`       | HEAD 時点のファイル内容               | PreviewPane の diff 表示                                     |
| `rpcGitShowCommitFile` | 指定 commit でのファイル内容          | GitGraph commit 詳細 → diff                                  |
| `rpcGitDiffHunks`      | 2 テキスト間の hunk 単位差分          | DiffPreview。`git diff --no-index` で計算 SSOT を git に置く |
| `rpcGitCommitFiles`    | `git add` + `git commit`              | ChangesPane の commit ボタン                                 |

### gh (GitHub API 経由)

| RPC               | 用途                           | 呼ばれる場面                      |
| ----------------- | ------------------------------ | --------------------------------- |
| `rpcGitPrList`    | PR 一覧 (GraphQL)              | PR picker (`cmd+P` 等) 起動時     |
| `rpcGitIssueList` | Issue 一覧 (GraphQL)           | Issue picker 起動時               |
| `rpcGitViewer`    | 認証ユーザー名 (`gh api user`) | `useViewer` cache が空のとき 1 回 |

`gh repo view` 経路は廃止済み。owner / repo は `git config --get remote.origin.url` の local parse (`parseGitHubOwnerRepo`) で取得する。`github.com` host のみ受理。

## push 経路 (native → renderer)

すべて FSEvents 経由で発火し、payload に `dir` を必須で持つ ([architecture.md](architecture.md#ssot-push-の-dir-filter-規律))。

| push event         | 発火源                                             | 主な subscriber                                                                |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `fsChange`         | worktree 内ファイルの変更                          | FilerPane (active dir のみ)                                                    |
| `gitStatusChange`  | `index` / working tree / HEAD の変更               | useGitStatusSync (全 worktree)、FilerPane / GitGraphPane (active のみ)         |
| `branchChange`     | `refs/heads/*` / `packed-refs`                     | GitGraphPane (同 repo の active worktree)、useSidebarData (source dir の repo) |
| `remoteRefsChange` | `refs/remotes/*` / `packed-refs` (push / fetch 後) | GitGraphPane (同 repo の active worktree)                                      |
| `worktreeChange`   | `worktrees/*` 配下                                 | useSidebarData (source dir の repo)                                            |
| `fsWatchReady`     | `rpcFsWatch` 成功直後の re-sync シグナル           | GitGraphPane (active)、useSidebarData (source dir)                             |

### primary watcher dedup

同じ commonGitDir を共有する N 個の worktree watcher で `refs/heads/*` のような共有領域の event が起きると、N 重発火する。`FSWatchRegistry` は resolved dir の lexical 最小 watcher 1 つに `branchChange` / `remoteRefsChange` / `worktreeChange` の dispatch を collapse する。

- `gitStatusChange` は per-worktree の ahead/behind を返すため dedup しない (各 worktree で値が異なる)
- 非 git project (`commonGitDir == nil`) では `branchChange` / `remoteRefsChange` / `worktreeChange` 自体が発火しない

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

| 発火元                                     | 場面                                        |
| ------------------------------------------ | ------------------------------------------- |
| `onMounted`                                | GitGraphPane マウント時                     |
| `watch(worktreeStore.dir)`                 | worktree 切替時 (interval も再スタート)     |
| `gitStatusChange` の **`upstreamChanged`** | push / fetch で ahead/behind が変化したとき |
| `useIntervalFn` (60 秒間隔)                | active worktree に対する定期取得            |

`branchChange` / `fsWatchReady` では PR list は再 fetch されない (refs 変化に伴う graph 再描画は `loadLog` 側で処理)。

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
