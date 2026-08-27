// git / GitHub 操作 RPC の型。

import type {
  EmptyMessage,
  FileReadResult,
  GhRef,
  GitCommit,
  GitFileChange,
  GitIssue,
  GitPullRequest,
  GitPullRequestBadge,
  GitPullRequestCheckState,
  Task,
  WorktreeEntry,
} from "./common";

// gitWorktreeList: worktree 一覧
export interface GitWorktreeListRequest {
  dir: string;
}
export interface GitWorktreeListResponse {
  worktrees: WorktreeEntry[];
}

/** git log の commit 並び順。
 * - "topo": `--topo-order` で第 1 親系統を連続させる
 * - "date": `--date-order` で commit date 降順を厳守 */
export type SortMode = "topo" | "date";

/** git graph が walk の始点にする ref の範囲。
 * - "current": HEAD だけを始点にする（現在ブランチのみ）
 * - "default": HEAD + `origin/<default>` + `@{upstream}` を始点にする（標準の 2 系統表示）
 * - "all": ローカル / リモートの全ブランチ ref を始点にする */
export type BranchScope = "current" | "default" | "all";

// gitLog: HEAD / `origin/<default>` / `@{upstream}` の各 ref を始点に
// 1 回の `git log --stdin --decorate=short` で walk する。
//
// 設計の根拠 (VSCode の Source Control Graph 実装 `extensions/git/src/git.ts` 参照):
// - main 側で N ref を Set で dedup → stdin で git に渡す
// - git 自身が walk 中に commit を dedup するため、renderer 側で merge / dedup する
//   ロジックは不要。topo / date order の決定も git に任せる
// - 副次効果として `git commit --amend` / 未 push の rebase 等で
//   `origin/<branch>` が HEAD から到達不可になっても、`@{upstream}` を始点 ref として
//   渡すため orphan tip / 祖先連鎖が visible commit set に含まれ、graph 上に
//   `origin/<branch>` の badge が残る
//
// `defaultBranch` 文字列は git log で決まらないので
// `git symbolic-ref refs/remotes/origin/HEAD` から main 側で求める
// (RefBadge の `isDefault` 表示に使う)。
export interface GitLogRequest {
  dir: string;
  maxCount: number;
  firstParentOnly: boolean;
  /** walk の始点 ref 範囲。`defaultBranch` 文字列は scope に依らず
   * `git symbolic-ref` で解決して返す。 */
  branchScope: BranchScope;
  sortMode: SortMode;
}
export interface GitLogResponse {
  /** 始点 ref を `git log --stdin` で walk した結果。child → parent 順、
   * sortMode に従って tie-break される。branchScope !== "current" で HEAD が
   * 新しい順 maxCount ウィンドウから押し出され結果に 1 件も含まれない場合のみ、HEAD-only
   * walk を追加して末尾に append する (古い現在ブランチを graph 上で見えるように救済。
   * HEAD 系統はウィンドウの最古 commit より古いため append で順序契約は保たれる)。 */
  commits: GitCommit[];
  /** `git symbolic-ref refs/remotes/origin/HEAD` の結果 (例: `main`)。
   * 解決失敗時 / origin 未設定時は空文字。 */
  defaultBranch: string;
  /** HEAD が指す branch 名 (例: `main` / `feature/foo`)。`git symbolic-ref --short HEAD`
   * の結果。detached HEAD では空文字。unborn branch (commit 無し) では branch 名が入る。
   * `git status --porcelain=v2 --branch` の `# branch.head` と同一の semantics で、
   * `gitStatusChange` push payload の `branchHead` と SSOT を一致させる目的で
   * 同一 RPC に含める。 */
  branchHead: string;
}

// gitDiffHunks: 2 つのテキスト間の hunk 単位差分を計算する。
//
// renderer 側で jsdiff の `diffLines()` を全文に対して回すと、`pnpm-lock.yaml` のような
// 数万行ファイルで Myers LCS が O(N×M) で爆発しメインスレッドが固まる。git の最適化された
// diff エンジン（xdiff、C 実装）に SSOT を移して計算コストを切り離す。
export interface GitDiffHunksRequest {
  original: string;
  current: string;
}

export type DiffLineKind = "context" | "added" | "removed";

interface DiffHunkLine {
  kind: DiffLineKind;
  text: string;
}

/** 1 hunk の範囲 + 各 line。start / lines は unified diff の
 * `@@ -oldStart,oldLines +newStart,newLines @@` と同じ意味で 1-based。
 * oldLines / newLines は context + 該当 side の add/remove の合計行数。 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export interface GitDiffHunksResponse {
  hunks: DiffHunk[];
  /** 入力 original / current の総行数。trailing バー描画と context 拡張の
   * 絶対座標計算は git の line counting 規約に揃える必要があるため、
   * SSOT を main 側に置く。renderer 側で `text.split("\n").length` を回すと
   * CRLF / 末尾改行の扱いが git と分かれて表示行数と実態がずれる。 */
  oldTotalLines: number;
  newTotalLines: number;
}

// gitDiffExpandLines: hunk-bar クリック展開用に original / current 全文から指定行範囲を切り出す。
//
// renderer 側で `text.split("\n")` を回すと CRLF / 末尾改行の扱いが main 側
// `countDiffLines` と分かれて、表示行と main が返す `oldTotalLines` / `newTotalLines`
// で末尾 1 行ずれる。バー展開も SSOT を main に寄せるため、専用 RPC で行配列を切り出す。
//
// 1-based。`oldStart` / `newStart` から `lines` 行分を取得する。範囲外は main 側で error。
export interface GitDiffExpandLinesRequest {
  original: string;
  current: string;
  oldStart: number;
  newStart: number;
  lines: number;
}

/** 1 行分の old / new テキストペア。
 * unified diff の invariant (hunk 間 / trailing の unchanged 行数は両側で一致) により
 * oldLineNo と newLineNo は必ずペアで存在する。 */
export interface DiffExpandedLine {
  oldLineNo: number;
  newLineNo: number;
  oldText: string;
  newText: string;
}

export interface GitDiffExpandLinesResponse {
  lines: DiffExpandedLine[];
}

// gitShowFile: HEAD のファイル内容
export interface GitShowFileRequest {
  dir: string;
  relPath: string;
}
export interface GitShowFileResponse {
  result: FileReadResult;
}

// gitShowCommitFile: 指定コミット（または 2 コミット間）のファイル内容
export interface GitShowCommitFileRequest {
  dir: string;
  relPath: string;
  hash: string;
  compareHash: string;
}
export interface GitShowCommitFileResponse {
  from: FileReadResult;
  to: FileReadResult;
  /** from と to の指す blob OID が一致しているか。
   * Filer 経由でコミット範囲外（差分のない）ファイルを選んだ場合の
   * 「Diff タブを出さない」判定の SSOT。renderer 側 content 比較は使わない。
   * true になるのは「from と to の OID が両方解決でき、かつ一致」したときのみ。
   * どちらかが解決失敗（root の `^` / 未追跡 path / repo 破損）した場合は false。
   * 既存の `from.notFound` / `to.notFound` を優先評価する規約は変えない。 */
  unchanged: boolean;
}

// gitCommitFiles: コミット（または範囲指定）の変更ファイル一覧
//
// 単一 commit 選択時は hash のみを使う。rangeHashes が非空なら range mode で、
// renderer が git-graph の first-parent walk で組み立てた commit hash 列を渡す。main 側は
// 配列の先頭（newer）と末尾（older）の 2 endpoint で `git diff <older>^ <newer>` を実行する。
export interface GitCommitFilesRequest {
  dir: string;
  hash: string;
  compareHash: string;
  /** 範囲選択時の対象 commit 列。renderer が newer から first-parent walk で組み立てる。
   * 配列は newer (上端) から older (下端) の順で、両端を含む閉区間。
   * 非空なら hash / compareHash は無視され、先頭と末尾の 2 endpoint diff が返る。 */
  rangeHashes: string[];
  /** 範囲選択の片端が Working Tree（UNCOMMITTED_HASH）の場合 true。
   * main 側で `git diff <older>^` (第二引数省略 = working tree 比較) に切り替える。 */
  includeWorkingTree: boolean;
}
export interface GitCommitFilesResponse {
  changes: GitFileChange[];
}

// gitPrDiffFiles: PR base..working tree の tracked 変更ファイル一覧
//
// baseHash は **`merge-base(HEAD, baseRefOid)` の OID** を渡す契約 (= GitHub の Files
// changed タブと同じ 3-dot semantics の左端)。renderer が `usePrDiffToggleStore.enable()`
// で `gitMergeBase` を呼び事前に解決した値を流す。`baseRefOid` を直接渡してはいけない:
// base ブランチが PR 分岐後に前進していると、その前進分が逆向きに差分として混入する
// (= 「自分のブランチに含まれていない main の変更」が PR diff に紛れ込む bug)。
//
// 内部では `git diff <baseHash>` (右辺省略 = working tree) を実行する。
// `--diff-filter=AMDR` で除外される untracked file (`??`) は本 RPC では返さない。
// untracked を `U` として写す責務は renderer 側 (`useChangesStore`) に閉じる。
export interface GitPrDiffFilesRequest {
  dir: string;
  baseHash: string;
}
export interface GitPrDiffFilesResponse {
  changes: GitFileChange[];
}

// gitMergeBase: 2 commit の最低共通祖先を返す。`git merge-base <hash1> <hash2>` 相当。
//
// PR diff モードの起点解決に使う。GitHub の Files changed タブが採る 3-dot semantics
// (`<base>...<head>`) は **「merge-base(base, head) から head までの差分」** を表すが、
// 3-dot **構文** は両辺が commit であることを要求するため working tree を含められない。
// 代わりに renderer 側で `gitMergeBase` を先に呼び、得た merge-base OID を
// `gitPrDiffFiles.baseHash` に渡して `git diff <merge-base>` (右辺省略 = working tree) を
// 実行することで、3-dot semantics と working tree 含有を両立する。
export interface GitMergeBaseRequest {
  dir: string;
  hash1: string;
  hash2: string;
}
export interface GitMergeBaseResponse {
  /** merge-base が解決できた場合のみ非空。unrelated histories / hash 不在等は空文字。
   * 空文字判定は呼び出し側 (`usePrDiffToggleStore.enable()`) で行い、トースト通知する。 */
  mergeBaseOid: string;
}

// gitReadBlob: 単一 rev + path の blob 内容を 1 つ返す
//
// gitShowFile (HEAD 固定) / gitShowCommitFile (2 endpoint 比較 + unchanged 判定) と独立した、
// 単一 rev / path に対する blob 取得 RPC。PR diff モードで base 側 blob を 1 個だけ取りたい用途。
// 失敗 (path がその rev に存在しない / rev が invalid 等) は result.notFound=true に倒す。
export interface GitReadBlobRequest {
  dir: string;
  hash: string;
  relPath: string;
}
export interface GitReadBlobResponse {
  result: FileReadResult;
}

// gitRevReachable: 指定 rev (commit OID) が local repo に reachable か
//
// `git cat-file -e <hash>` 相当。reachable=false なら呼び出し側は git fetch を要求する。
// PR diff の base reachable 判定で fetch を必要最小限に絞るために使う。
export interface GitRevReachableRequest {
  dir: string;
  hash: string;
}
export interface GitRevReachableResponse {
  reachable: boolean;
}

/** gh 経路の失敗種別。`ok=false` のとき renderer 側で文言を区別するために使う。
 * "ok" は ok=true 時のデフォルト値で、`ok=false` 時に "ok" のまま来ることはない。
 * main 側 `classifyGhStderr` の分類文字列と同一（境界での変換なし）。 */
export type GhErrorKind =
  | "ok"
  | "rateLimit"
  | "unauthenticated"
  | "repoNotFound"
  | "network"
  | "other";

// gitPrList: repo の open PR 一覧（選ばせるための母集合）を 1 ページ返す
//
// **ページ送りは呼び出し側が回す。**全ページを取り切ってから返すと、最初の 1 ページが手元に
// あるのに何も出せない。途中経過を表示できるのは表示側だけなので、繰り返しの制御もそちらに置く。
export interface GitPrListRequest {
  dir: string;
  /** 続きを取るカーソル。先頭ページでは未設定 */
  after?: string;
}
export interface GitPrListResponse {
  /** ok=false は gh CLI 未認証 / rate limit / repo 不在 等で取得不能を示す */
  ok: boolean;
  prs: GitPullRequest[];
  /** 次ページのカーソル。空文字は「続きが無い」 */
  nextCursor: string;
  /** open PR の総数。取得済み件数と並べて進捗を示す。
   * fork PR を除外する前の数なので、取得済み件数がここへ到達しないことがある。 */
  totalCount: number;
  errorKind: GhErrorKind;
  /** 表示しないが debug 用に stderr の冒頭を載せる（最大 512B 程度に切り詰める想定） */
  errorDetail: string;
}

// gitPrsForBranches: 指定した branch に紐づく open PR（グラフのバッジ用）
//
// 一覧取得と型を共有せず別の request として持つ。問いが違うため運ぶ範囲も発火の頻度も違う
// （docs/git.md「PR の取得は問いごとに分ける」）。
export interface GitPrsForBranchesRequest {
  dir: string;
  /** 引きたい branch 名。`origin/` 接頭辞は含めない */
  branches: string[];
}
export interface GitPrsForBranchesResponse {
  ok: boolean;
  /** 要求した branch のうち open PR を持つものだけが、**1 branch につき最大 1 件**返る。
   * 同じ head に複数の open PR があるときは最新の 1 件。順序は保証しない */
  prs: GitPullRequestBadge[];
  errorKind: GhErrorKind;
  errorDetail: string;
}

// gitIssueList: gh issue list
export interface GitIssueListRequest {
  dir: string;
}
export interface GitIssueListResponse {
  ok: boolean;
  issues: GitIssue[];
  errorKind: GhErrorKind;
  errorDetail: string;
}

// gitMyWork: 認証ユーザー単位の作業一覧（repo 横断）
//
// repo 単位の `GitPrListRequest` / `GitIssueListRequest` と型を共有しない。あちらは
// worktree 作成の startPoint 解決に使う ref 情報が本体で、こちらは repo をまたいで
// 「開いて確認する」ためのリンクが本体。取得単位（repo / 認証ユーザー）も違う。

/** PR に対するレビューの総合結果。GitHub GraphQL の `PullRequestReviewDecision` に対応する。
 * 型は list から導出する（`GIT_PULL_REQUEST_CHECK_STATES` と同流儀）。 */
export const GIT_PULL_REQUEST_REVIEW_DECISIONS = [
  "CHANGES_REQUESTED",
  "APPROVED",
  "REVIEW_REQUIRED",
] as const;

export type GitPullRequestReviewDecision = (typeof GIT_PULL_REQUEST_REVIEW_DECISIONS)[number];

/** GitHub 項目の種別。my work の行・リンクと、種別を描く表示語彙が同じ集合を指す。 */
export type GitItemKind = "pr" | "issue";

/** my work パネルが描く 1 行。PR と issue の双方をこの 1 型で表す。 */
export interface GitMyWorkItem {
  kind: GitItemKind;
  /** `owner/name`。repo をまたぐ一覧なので行ごとに帰属先を持つ */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatarUrl: string;
  /** ISO 8601 */
  updatedAt: string;
  /** issue では常に false */
  isDraft: boolean;
  /** head ref の CI 総合結果。issue と、check が 1 つも無い commit では undefined */
  checkState?: GitPullRequestCheckState;
  /** レビューの総合結果。issue と、レビュー設定の無い PR では undefined */
  reviewDecision?: GitPullRequestReviewDecision;
  /** 会話の総量。数え方は `GitPullRequest.commentCount` の doc が SSOT */
  commentCount: number;
  /**
   * viewer がまだ読んでいない更新を持つ。GitHub が viewer ごとに持つ既読状態の反転で、
   * 一覧に出る青いラインと同じ事実を指す。
   *
   * 既読にする API は存在しない（schema の Mutation に該当フィールドが無い）ため、この値は
   * **読み取り専用**。gozd 側で既読の定義を持つと GitHub の状態と二重管理になり、片方だけ
   * ずれた状態を作れてしまうので持たない。
   */
  isUnread: boolean;
}

/**
 * 軸の検索条件を GitHub 上で開くリンク。検索ページは PR / issue が別種別で混在を
 * 1 ページに出せないため、軸が含む種別ごとに 1 本持つ。全リンクの母集合の和が
 * 一覧の母集合と一致する。
 */
export interface GitMyWorkWebLink {
  kind: GitItemKind;
  url: string;
}

/**
 * 1 つの軸の取得結果。
 *
 * `totalCount` は検索条件に一致する総件数で、`items` は取得上限で切られるため両者は一致
 * するとは限らない。「上限ちょうどで止まっている」のか「たまたま同数」なのかは件数だけでは
 * 区別できないため、総件数を別に運ぶ。
 *
 * 「続きがあるか」は `totalCount > items.length` で導出する。真偽値を別フィールドで運ぶと
 * 同じ事実の表現が 2 つになり、片方だけずれた状態を作れてしまう。
 */
export interface GitMyWorkGroup {
  items: GitMyWorkItem[];
  totalCount: number;
  /** 同じ検索条件を GitHub 上で開くリンク。上限で切れた残りへ到達する導線であり、
   * 一覧と同じ条件から導出されるため両者の母集合は一致する */
  webLinks: GitMyWorkWebLink[];
}

/** 認証ユーザー単位なので repo を指す引数を持たない */
export type GitMyWorkRequest = EmptyMessage;

/**
 * my work の軸キー。型は list から導出する（`GIT_PULL_REQUEST_CHECK_STATES` と同流儀）。
 * list の並びは表示順で、消費側（パネルのペイン、main の query 組み立て）はこの list の
 * 走査から順序を導出する。
 *
 * 各軸の検索条件は取得側の軸定義が SSOT。ここは軸の集合と並びだけを持つ。
 */
export const GIT_MY_WORK_AXIS_KEYS = [
  "authoredIssues",
  "authoredPrs",
  "mentioned",
  "reviewRequestedPrs",
] as const;

export type GitMyWorkAxisKey = (typeof GIT_MY_WORK_AXIS_KEYS)[number];

export interface GitMyWorkResponse {
  ok: boolean;
  groups: Record<GitMyWorkAxisKey, GitMyWorkGroup>;
  errorKind: GhErrorKind;
  errorDetail: string;
}

// gitViewer: 認証中の GitHub viewer login
export interface GitViewerRequest {
  dir: string;
}
export interface GitViewerResponse {
  ok: boolean;
  login: string;
  errorKind: GhErrorKind;
  errorDetail: string;
}

// gitFetchRemotes: `git fetch --all --no-write-fetch-head` 相当。
// 背景自動 fetch で refs/remotes/<remote>/* を更新し、status 経路 (FSWatchRegistry →
// gitStatusFull → gitStatusChange push) を介して各 worktree の ahead/behind を最新化する。
// upstream が origin 以外 (例: fork PR workflow で upstream=upstream / origin=fork) でも
// 全 remote を更新できるよう --all を採用。VSCode autofetch の "all" モード相当。
// 失敗 (offline / 認証失敗等) は ok=false + errorDetail で返し、呼び出し側で握り潰す。
export interface GitFetchRemotesRequest {
  dir: string;
}
export interface GitFetchRemotesResponse {
  ok: boolean;
  /** 失敗時の stderr 冒頭 (debug 用、最大 512B 程度に切り詰める) */
  errorDetail: string;
}

// gitGithubIdentity: active worktree の origin remote から GitHub の (owner, repo) を返す。
// 内部実装は `gh pr list` 経路と `repoOwnerName` を共有することで、
// 「git CLI への入力 / parser / host policy」すべてを 1 箇所に集約した SSOT 設計。
//
// host policy は **github.com 限定** (`gh` のデフォルト host と合わせる)。非 github.com
// remote、および remote 未設定 / parse 失敗はすべて owner / repo を空文字で返す。
// renderer 側はコミットメッセージ中の `#N` を issue リンクにするのに使い、空文字なら plain text。
//
// wire format 上は失敗 3 経路 (remote 未設定 / 非 github.com / parser 拒否) を空文字 1 種類に
// 圧縮するが、main 側では経路別に stderr ログを残す（`[handleGitGithubIdentity]`）。
export interface GitGithubIdentityRequest {
  dir: string;
}
export interface GitGithubIdentityResponse {
  owner: string;
  repo: string;
}

// createWorktree: Task を伴わない worktree を作成する。
//
// 置き場所・起点 ref・leaf 名はすべて main が決めるため、呼び出し側は対象の repo だけを渡す。
export interface CreateWorktreeRequest {
  /** repo 内の任意の dir。main 側で main repo root に解決する */
  dir: string;
}
export interface CreateWorktreeResponse {
  /** 解決済みの main repo root。renderer は自身で解決せずこの値を worktree の帰属先に使う */
  rootDir: string;
  worktree: WorktreeEntry;
  /** 作成した worktree の絶対パス */
  dir: string;
  /** project 設定の setupScript。renderer が専用ターミナルで実行する。空なら実行しない */
  setupScript: string;
}

// createTaskWorktree: worktree 作成と task 紐づけを 1 往復で行う合成操作。
//
// worktree だけが出来て task が付かない中間状態を呼び出し側に見せないための単位。
// PR / issue picker と `gozd worktree new`（ソケット経由）が同じ経路を通る。
//
// branch / startPoint は空文字が「main 側で決めろ」を意味する:
//   - branch 空: timestamp（`generateTimestamp`）を branch 名にする
//   - startPoint 空: default branch（`resolveStartPoint` の二段 fallback）を起点にする
// PR picker だけが両方を明示する（`<headRef>` を `origin/<headRef>` から作る）。
export interface CreateTaskWorktreeRequest {
  /** repo 内の任意の dir。main 側で main repo root に解決する */
  dir: string;
  branch: string;
  startPoint: string;
  /** 作成する task の ghTitle */
  ghTitle: string;
  ghRef?: GhRef;
}
export interface CreateTaskWorktreeResponse {
  /** 解決済みの main repo root。renderer は自身で解決せずこの値を worktree の帰属先に使う */
  rootDir: string;
  worktree: WorktreeEntry;
  /** 作成した worktree の絶対パス */
  dir: string;
  task: Task;
  /** project 設定の setupScript。renderer が専用ターミナルで実行する。空なら実行しない */
  setupScript: string;
}

/** newWorktree push payload。ソケット (`gozd worktree new`) 由来で main が作った worktree を
 * renderer に開かせる。作成そのものは main で完了しているため、renderer の責務は
 * 「サイドバーに載せる → setup / autostart のヒントを立てる → 端末を起こす」だけ。
 * この経路の起点はエージェントなので、選択中の worktree は動かさない (docs/task.md)。
 *
 * 作成結果とプロンプトを 1 つの push に載せるのは、autostart ヒントが端末の起動より先に
 * 立っていないと初期 leaf が素のシェルで作られてしまい、claude が起動しないため。
 * 2 つの push に割ると、間に挟まる await の分だけ順序が保証できなくなる。 */
export interface NewWorktreePayload extends CreateTaskWorktreeResponse {
  /** 起動する claude に引数で渡すプロンプト。空なら素の claude を起動する */
  prompt: string;
  /** repo の表示名（main repo の basename）。この repo が window に未登録だったときだけ使う */
  repoName: string;
}

// gitWorktreeRemove: worktree を削除
export interface GitWorktreeRemoveRequest {
  dir: string;
  path: string;
  force: boolean;
}
export type GitWorktreeRemoveResponse = EmptyMessage;

// gitBlameLine: 1 行の blame 結果を返す。
// `git blame --porcelain -L <line>,<line> [<rev>] -- <relPath>` 相当。
//
// rev の参照は 3 通り:
//   - "" (空文字): rev を渡さず working tree を blame。ローカル未コミット変更を含む
//   - "HEAD" / <commit hash> / "<hash>^": そのコミットの blob を blame
//
// 単一行 RPC として設計しているのは popover UI 用途のため。ファイル全体の gutter 常時表示が
// 要件になった時点で全行版を別 RPC で足す（並列でファイル全体を 1 度に取らせる方が cheap）。
export interface GitBlameLineRequest {
  dir: string;
  relPath: string;
  rev: string;
  /** 1-based */
  line: number;
}

export interface GitBlameCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorMail: string;
  /** Unix timestamp (秒) */
  authorTime: number;
  /** commit メッセージ subject (1 行目) */
  summary: string;
  /** commit 内のソース行番号 (history 起点として使う) */
  sourceLine: number;
  /** hash が全 0 (working tree の未コミット行) なら true。
   * この場合 author / authorMail / summary は git が "Not Committed Yet" 系を返すため
   * renderer 側で「未コミット」表記に倒す。 */
  notCommitted: boolean;
}

export interface GitBlameLineResponse {
  commit: GitBlameCommit;
}

// gitLogLine: 指定行の変更履歴を返す。`git log -L<line>,<line>:<relPath> --no-patch <rev>` 相当。
//
// rev は **必須** (空文字は main 側で reject される)。呼び出し側 (renderer の
// `useBlamePopover`) は必ず「blame で得た commit hash」を起点として流す契約で、
// HEAD 起点 walk に倒れると「blame した commit を含まない history」が返って
// 意味契約が壊れるため。許容形式は `validateRev` 同等 (HEAD / hex hash / 末尾 `^` / `~N`)。
//
// maxCount は 0 のとき git にも `--max-count` を渡さない (= 全件)。
// `git log -L` は patch が出るのが default だが、popover では commit 一覧だけ欲しいため
// `--no-patch` で抑制する。
export interface GitLogLineRequest {
  dir: string;
  relPath: string;
  rev: string;
  line: number;
  maxCount: number;
}

export interface GitLogLineResponse {
  commits: GitCommit[];
}

// gitLogFile: ファイル全体の変更履歴を返す。`git log --no-patch <rev> -- <relPath>` 相当。
//
// preview ヘッダのコミット日表示 (maxCount=1) と、そこから開くファイル history popover
// (一覧) で使う。`gitLogLine` (行単位) と違い blame-anchored 契約を持たないため、
// rev は **空文字を許容** する (空文字 = HEAD を walk = ファイルの最新コミット起点)。
export interface GitLogFileRequest {
  dir: string;
  relPath: string;
  rev: string;
  maxCount: number;
}

export interface GitLogFileResponse {
  commits: GitCommit[];
}

// gitResetMixed: active worktree の現在 branch を指定コミットへ `git reset --mixed <hash>` で移動する。
//
// git-graph の commit 行の右クリックメニュー「Reset (mixed) to here」から呼ぶ。
// `--mixed` は branch ref を <hash> に移動し index を <hash> の状態に reset するが、
// working tree のファイルは一切書き換えない (reflog で復元可能な soft な操作)。
//
// hash は `validateRev` に通して option 注入 (`-` 始まり) / 非 hex を reject し、
// `isAllZeroHex` で UNCOMMITTED_HASH (working tree sentinel) を弾く。branch ref / index の
// 変化は per-worktree FSWatch が拾い push 経由で git-graph が自動再描画するため、
// response に追加データは載せない。
export interface GitResetMixedRequest {
  dir: string;
  hash: string;
}
export type GitResetMixedResponse = EmptyMessage;

// gitLsTree: 指定コミットの tree から 1 階層分のエントリを返す。
//
// filer の snapshot mode (git-graph でコミット選択中) が呼ぶ。`git ls-tree -z <hash> <path>/`
// に対応し、`path` 末尾 `/` を main 側で必ず付与する規約 (末尾 `/` を外すと「該当 path の
// エントリ 1 件」が返って 1 階層分の列挙にならないため)。`path` が空文字 ("") なら repo root の
// 1 階層分を返す。
//
// type は "file" / "directory" / "symlink" / "submodule" のいずれか (git mode → 文字列写像は
// main 側 `gitTree.ts` の SSOT に置く)。FsReadDirEntry とフィールド名を揃え、renderer 側の
// エントリ構築経路を共通化する (snapshot mode で `isIgnored` は意味を持たないため省略)。
export interface GitLsTreeRequest {
  dir: string;
  hash: string;
  path: string;
}

export interface GitTreeEntry {
  name: string;
  type: string;
  /** submodule（gitlink）が指す commit hash。`type === "submodule"` のときだけ設定する。 */
  submoduleHash?: string;
}

export interface GitLsTreeResponse {
  entries: GitTreeEntry[];
}

// gitSubmoduleUrl: submodule が指す commit の GitHub 閲覧 URL を解決する。
//
// filer の submodule 行 click が呼ぶ。path → url の対応は `.gitmodules` にしか無いが、
// submodule 判定そのものは index の gitlink が SSOT なので経路を分けてある（main 側
// `submodule.ts` の SSOT）。readDir 応答に url を載せず click 時に引くのは、リンクを踏む
// ときにしか要らない情報のために全列挙で `.gitmodules` を読まないため。
export interface GitSubmoduleUrlRequest {
  dir: string;
  /** submodule の worktree 相対パス */
  path: string;
  /** submodule が指す commit hash。URL に埋めて pin する */
  hash: string;
  /** `.gitmodules` を読む revision。filer の snapshot mode が自身の commit hash を渡す。
   * 未設定なら working tree の `.gitmodules` を読む（hash と url の出所を揃えるための指定で、
   * path → url の対応は commit 間で変わり得る）。 */
  rev?: string;
}

export interface GitSubmoduleUrlResponse {
  /** 解決できた閲覧 URL。`.gitmodules` に記述が無い / 非 github.com host なら未設定 */
  url?: string;
}

// gitLsFiles: worktree 内の全ファイル（tracked + untracked、gitignore 除外）の相対パスを返す。
//
// file picker（Go to File）が worktree 単位の全ファイル列挙に使う。
// `git ls-files -z --cached --others --exclude-standard` に対応し、`--cached` が拾う
// 「index にあるが working tree から削除済み」のエントリは main 側で除外する
// （picker はディスクに実在するファイルだけを開く対象として提示する契約）。
export interface GitLsFilesRequest {
  dir: string;
}

export interface GitLsFilesResponse {
  files: string[];
}
