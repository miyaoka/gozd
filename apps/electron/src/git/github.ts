// GitHub 連携。Swift 版 `GitHubOps.swift` の対応物。
//
// 設計判断（Swift 版から継承）:
// - **gh CLI 必須**。未認証 / rate limit / repo 不在等の non-zero exit は stderr から
//   GhError 4 種に分類して返し、renderer 側で文言を出し分ける（全失敗の nil 一律化では
//   rate limit 枯渇に気づけない）
// - **GraphQL 経由**。`gh pr list --json author` は avatarUrl を返さない。bot アカウント
//   （renovate 等）も正しく解決するため `https://github.com/{login}.png` 構築は採らない
// - `gh` の絶対パスは git と同じく commandResolver（ユーザーログインシェル経由）で解決する。
//   Finder/Dock 起動の最小 PATH には Homebrew の `gh` が存在せず、Apple stub にも救われない
//   （設計理由は commandResolver.ts 冒頭コメント参照）

import type {
  GitIssue,
  GitMyWorkGroup,
  GitMyWorkItem,
  GitMyWorkWebLink,
  GitPullRequest,
  GitPullRequestCheckState,
  GitPullRequestReviewDecision,
} from "@gozd/rpc";
import { GIT_PULL_REQUEST_CHECK_STATES, GIT_PULL_REQUEST_REVIEW_DECISIONS } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { withResolvedCommand } from "../commandResolver";
import { GitCommandError, runGit } from "./gitRunner";

const execFileAsync = promisify(execFile);

export type RepoIdentity =
  | { kind: "ok"; owner: string; repo: string }
  | { kind: "unsetRemote" }
  | { kind: "parserRejected" };

/**
 * origin remote から GitHub の (owner, repo) を返す。
 *
 * - `unsetRemote`: `remote.origin` が未設定（新規 repo / clone なし）
 * - `parserRejected`: 非 github.com host / 想定外 URL 形式。raw URL は credential
 *   漏出防止のため呼び出し側に渡さない
 */
export async function repoOwnerName(dir: string): Promise<RepoIdentity> {
  const result = await tryCatch(runGit(["config", "--get", "remote.origin.url"], dir));
  if (!result.ok) {
    if (result.error instanceof GitCommandError) return { kind: "unsetRemote" };
    throw result.error;
  }
  const parsed = parseGitHubOwnerRepo(result.value.trim());
  if (parsed === undefined) return { kind: "parserRejected" };
  return { kind: "ok", ...parsed };
}

type GhErrorKindName = "rateLimit" | "unauthenticated" | "repoNotFound" | "network" | "other";

interface GhError {
  kind: GhErrorKindName;
  detail: string;
}

export type GhResult<T> = { ok: true; value: T } | { ok: false; error: GhError };

// GitHub の avatar 画像サイズ（px）。PR/Issue picker 行の表示サイズに合わせる
const AVATAR_SIZE = 64;

// `owner { login }` は廃止（fork 判定にはローカルで parse した owner を使う）。
// `assignees` / `reviewRequests` は PR picker の filter 機能で参照するため一覧 query に含める。
//
// GraphQL の rate limit cost は connection 1 つにつき「親の件数ぶんの request」で積まれ、
// その合計を 100 で割って算出される。`statusCheckRollup` は connection ではないため cost に
// 乗らない。CI 結果を `commits(last: 1)` 経由で取ると connection が 1 つ増えて cost が上がる
// ので、PullRequest 直下の rollup を使う。
// connection の `totalCount` も `first` / `last` を渡さなければページを 1 枚も要求しないため
// cost に乗らない。件数系はこの形でだけ取る。
const PR_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        headRefName
        baseRefName
        baseRefOid
        author { login avatarUrl(size: ${AVATAR_SIZE}) }
        updatedAt
        headRepository { owner { login } }
        assignees(first: 100) { nodes { login } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
        statusCheckRollup { state }
        comments { totalCount }
        reviews { totalCount }
        reviewThreads { totalCount }
      }
    }
  }
}`;

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    issues(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        author { login avatarUrl(size: ${AVATAR_SIZE}) }
        updatedAt
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
      }
    }
  }
}`;

/** open PR 一覧 */
export async function prList(dir: string): Promise<GhResult<GitPullRequest[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, PR_QUERY), dir);
  if (!raw.ok) return raw;
  const nodes = nodesAt(raw.value, "pullRequests");
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  return { ok: true, value: parsePullRequestNodes(nodes, owner) };
}

/**
 * PR 一覧 query の nodes を `GitPullRequest` へ変換する pure 関数。取得経路はすべてこれを
 * 経由する SSOT で、snapshot 入力に対する境界の振る舞いをここに閉じる。
 *
 * fork PR（head owner ≠ local owner）は除外する: worktree 作成側が `origin/<headRef>` を
 * startPoint に使うため、fork からの PR は ref 解決に失敗する。`owner` は remote URL から
 * local に解決した値を渡す。
 */
export function parsePullRequestNodes(nodes: unknown[], owner: string): GitPullRequest[] {
  const prs: GitPullRequest[] = [];
  for (const item of nodes) {
    const headOwner = str(getPath(item, "headRepository", "owner", "login"));
    if (headOwner !== owner) continue;
    prs.push({
      number: int(getPath(item, "number")),
      title: str(getPath(item, "title")),
      url: str(getPath(item, "url")),
      state: str(getPath(item, "state")),
      author: str(getPath(item, "author", "login")),
      headRef: str(getPath(item, "headRefName")),
      baseRef: str(getPath(item, "baseRefName")),
      isDraft: getPath(item, "isDraft") === true,
      assignees: logins(getPath(item, "assignees", "nodes"), "login"),
      reviewers: reviewerLogins(getPath(item, "reviewRequests", "nodes")),
      updatedAt: str(getPath(item, "updatedAt")),
      authorAvatarUrl: str(getPath(item, "author", "avatarUrl")),
      baseRefOid: str(getPath(item, "baseRefOid")),
      checkState: checkState(getPath(item, "statusCheckRollup", "state"), "prList"),
      commentCount: commentCount(item),
    });
  }
  return prs;
}

/** open issue 一覧 */
export async function issueList(dir: string): Promise<GhResult<GitIssue[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, ISSUE_QUERY), dir);
  if (!raw.ok) return raw;
  const nodes = nodesAt(raw.value, "issues");
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  const issues: GitIssue[] = nodes.map((item) => ({
    number: int(getPath(item, "number")),
    title: str(getPath(item, "title")),
    url: str(getPath(item, "url")),
    state: str(getPath(item, "state")),
    author: str(getPath(item, "author", "login")),
    labels: logins(getPath(item, "labels", "nodes"), "name"),
    assignees: logins(getPath(item, "assignees", "nodes"), "login"),
    updatedAt: str(getPath(item, "updatedAt")),
    authorAvatarUrl: str(getPath(item, "author", "avatarUrl")),
  }));
  return { ok: true, value: issues };
}

// 1 グループあたりの取得上限。`search` connection が 1 回で返せる上限そのもので、これを
// 超えると `EXCESSIVE_PAGINATION` になる。全軸を上限で取っても cost は 1 のままなので
// 絞る理由が無い。
//
// ここから先はカーソルを辿る往復が要る。ページングは持たず、切れているかどうかを
// `issueCount` で示して GitHub 上の同じ検索へ送る。
const MY_WORK_LIMIT = 100;

/**
 * 軸ごとの検索条件。**GraphQL の取得と GitHub 上の一覧 URL は同じ定義から導出する** —
 * 別々に書くと、リンク先が一覧と違う母集合を出すようになる。
 *
 * `@me` は GraphQL search でも GitHub の検索ページでもそのまま解決されるため、viewer
 * login を別途取らない。`review-requested:@me` は自分が属する team 宛のレビュー依頼も
 * 含む（GitHub の検索仕様）。直接依頼だけに絞るなら `user-review-requested:@me`。
 *
 * `mentions:@me` は PR と issue の両方に一致する（kind: "mixed"）。本文・コメントの直接
 * メンションのみで、team 宛メンション（`@org/team`）は含まない（あちらは `team:` qualifier）。
 *
 * > [!NOTE]
 * > issue の検索ページは `archived` を「サポート外」と警告するが、実際には適用される
 * > （警告を出しつつ除外後の件数を返す）。除外の有無で件数が変わることを実測で確認して
 * > いるため、警告に合わせて条件を落とさない。落とすとリンク先だけ母集合が広がる。
 */
// 並びは表示順（MyWorkPanel の AXES / docs/git.md の軸テーブルと同順）:
// 自分が作ったもの（issue → PR）→ 自分に向けられたもの（メンション → レビュー依頼）。
// issue → PR の順は GitHub web の種別並び（Issues / Pull requests）に合わせる。
const MY_WORK_SEARCHES = [
  {
    key: "authoredIssues",
    kind: "issue",
    query: "is:open is:issue author:@me archived:false sort:updated-desc",
  },
  {
    key: "authoredPrs",
    kind: "pr",
    query: "is:open is:pr author:@me archived:false sort:updated-desc",
  },
  {
    key: "mentioned",
    kind: "mixed",
    query: "is:open mentions:@me archived:false sort:updated-desc",
  },
  {
    key: "reviewRequestedPrs",
    kind: "pr",
    query: "is:open is:pr review-requested:@me archived:false sort:updated-desc",
  },
] as const satisfies readonly {
  key: string;
  kind: "pr" | "issue" | "mixed";
  query: string;
}[];

/**
 * kind → `nodes` に展開する selection。mixed は union（`Issue | PullRequest`）の両型を受け、
 * 行の種別を `__typename` で判定するため mixed だけがそれを要求する。
 */
const MY_WORK_NODE_SELECTIONS = {
  pr: "...prFields",
  issue: "...issueFields",
  mixed: "__typename ...prFields ...issueFields",
} as const;

/**
 * 軸の集合は `MY_WORK_SEARCHES` から導出する。手書きで並べると、軸を足したときに
 * テーブルと型の両方を直す必要が生じ、片方だけ直した状態を作れてしまう。
 *
 * ワイヤ型（`GitMyWorkResponse`）との整合は routes 側の `satisfies` が見る。軸の削除や
 * 改名はそこで compile error になる。
 */
export type MyWork = Record<(typeof MY_WORK_SEARCHES)[number]["key"], GitMyWorkGroup>;

/** GitHub の検索ページの種別。PR と issue でタブが分かれており、issue の検索は
 * `is:pr` を受け付けない */
const KIND_WEB_TYPE = { pr: "pullrequests", issue: "issues" } as const;

/**
 * 同じ検索条件を GitHub の検索ページで開くリンク。検索ページには混在を 1 ページに出す
 * 種別が無いため、mixed 軸は種別タブごとに 1 本ずつ出す。query は共通なので、全リンクの
 * 母集合の和が一覧の母集合と一致する。
 */
function myWorkWebLinks(search: (typeof MY_WORK_SEARCHES)[number]): GitMyWorkWebLink[] {
  // issue → pr の順は GitHub web の種別並び（Issues / Pull requests）に合わせる
  const kinds = search.kind === "mixed" ? (["issue", "pr"] as const) : [search.kind];
  return kinds.map((kind) => ({
    kind,
    url: `https://github.com/search?${new URLSearchParams({ q: search.query, type: KIND_WEB_TYPE[kind] }).toString()}`,
  }));
}

/**
 * 認証ユーザー単位の作業一覧を **1 往復・rate limit cost 1** で取る query。
 *
 * GraphQL の cost は「各 connection を満たすのに必要なリクエスト数の合計を 100 で割って
 * 四捨五入し、最小 1」なので、search を軸の数だけ並べて `first` を上限まで上げても
 * 軸数ぶんのリクエスト相当にしかならず cost 1 に収まる。REST の `/search/issues` を軸ごとに
 * 叩く形（軸数ぶんのリクエスト + search 専用の分間制限を消費）とはここが決定的に違う。
 *
 * `search(type: ISSUE)` の node は `Issue | PullRequest` の union なので、CI / レビュー結果は
 * PullRequest 側の named fragment で取る。`statusCheckRollup` は connection ではないため
 * cost に乗らず、`comments { totalCount }` も `first` / `last` を渡さない限りページを
 * 要求しないので同じく乗らない（PR_QUERY 冒頭のコメントと同じ規律）。`issueCount` も同様。
 *
 * 取得上限で切れているかどうかを示すのに `pageInfo { hasNextPage }` を併載しないのは、
 * `issueCount` と取得件数の比較で同じ事実が得られ、境界に同じ事実の表現を 2 つ持たせない
 * ため。
 *
 * 検索条件は変数で渡す。query 文字列に埋め込むと、条件に引用符が入った瞬間に GraphQL の
 * 構文を壊す。
 *
 * 軸ごとの変数宣言と search エイリアスは `MY_WORK_SEARCHES` から組み立てる。手書きで並べると
 * 軸の一覧が 2 箇所に存在し、片方だけ足した状態を作れてしまう（未宣言の変数はサーバー側で
 * 無視されるため、取得は「その軸が応答に無い」形で落ちる）。
 */
export const MY_WORK_QUERY = `
query($limit: Int!, ${MY_WORK_SEARCHES.map((s) => `$${s.key}: String!`).join(", ")}) {
${MY_WORK_SEARCHES.map(
  (s) => `  ${s.key}: search(type: ISSUE, query: $${s.key}, first: $limit) {
    issueCount
    nodes { ${MY_WORK_NODE_SELECTIONS[s.kind]} }
  }`,
).join("\n")}
}

fragment prFields on PullRequest {
  number
  title
  url
  isDraft
  updatedAt
  repository { nameWithOwner }
  author { login avatarUrl(size: ${AVATAR_SIZE}) }
  reviewDecision
  statusCheckRollup { state }
  comments { totalCount }
  reviews { totalCount }
  reviewThreads { totalCount }
}

fragment issueFields on Issue {
  number
  title
  url
  updatedAt
  repository { nameWithOwner }
  author { login avatarUrl(size: ${AVATAR_SIZE}) }
  comments { totalCount }
}`;

/**
 * 認証ユーザー単位の作業一覧（repo 横断）。
 *
 * repo に紐づかないため cwd は home を使う。`gh api graphql` は repo 外でも動き、
 * 認証は gh の global config が持つ。
 */
export async function myWork(): Promise<GhResult<MyWork>> {
  const args = [
    "api",
    "graphql",
    "-F",
    `limit=${MY_WORK_LIMIT}`,
    ...MY_WORK_SEARCHES.flatMap((search) => ["-f", `${search.key}=${search.query}`]),
    "-f",
    `query=${MY_WORK_QUERY}`,
  ];
  const raw = await runGhCategorized(args, homedir());
  if (!raw.ok) return raw;

  const parsed = tryCatch(() => JSON.parse(raw.value) as unknown);
  if (!parsed.ok) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  return parseMyWorkResponse(parsed.value);
}

/**
 * my work query の応答（parse 済み JSON）を `MyWork` へ変換する pure 関数。取得経路は
 * これを経由する SSOT で、応答 shape に対する境界の振る舞いをここに閉じる。
 *
 * `nodes` と `issueCount` は同じ 1 応答から来る同格の必須フィールドなので、どちらの欠落も
 * 応答 shape エラーにする。`issueCount` を 0 に倒すと「行が並んでいるのに総件数 0」という
 * 事実でない要約が描かれる。
 */
export function parseMyWorkResponse(response: unknown): GhResult<MyWork> {
  const result = {} as MyWork;
  for (const search of MY_WORK_SEARCHES) {
    const nodes = getPath(response, "data", search.key, "nodes");
    if (!Array.isArray(nodes)) {
      return { ok: false, error: { kind: "other", detail: `missing nodes: ${search.key}` } };
    }
    const totalCount = getPath(response, "data", search.key, "issueCount");
    if (typeof totalCount !== "number") {
      return { ok: false, error: { kind: "other", detail: `missing issueCount: ${search.key}` } };
    }
    result[search.key] = {
      items: parseMyWorkNodes(nodes, search.kind),
      totalCount,
      webLinks: myWorkWebLinks(search),
    };
  }
  return { ok: true, value: result };
}

/**
 * 取得失敗時に返す空の一覧。`webLinks` は取得の成否に依存しないので埋める（失敗中でも
 * GitHub 上で確認する導線は残る）。
 *
 * 呼び出しごとに新しいオブジェクトを作る。1 つを全軸で使い回すと、いずれかに in-place
 * 変更が入った瞬間に全軸が同時に動く。
 */
export function emptyMyWork(): MyWork {
  const result = {} as MyWork;
  for (const search of MY_WORK_SEARCHES) {
    result[search.key] = { items: [], totalCount: 0, webLinks: myWorkWebLinks(search) };
  }
  return result;
}

/**
 * mixed 軸の行種別。`search(type: ISSUE)` の union は `Issue | PullRequest` の 2 型。
 * 未知の型名は観察ログを残し、フィールドが両型の共通部分である issue に倒す。
 */
function mixedNodeKind(item: unknown): "pr" | "issue" {
  const typename = getPath(item, "__typename");
  if (typename === "PullRequest") return "pr";
  if (typename !== "Issue") {
    console.error(`[myWork] unknown __typename: ${JSON.stringify(typename)}`);
  }
  return "issue";
}

/** my work query の nodes を `GitMyWorkItem` へ変換する pure 関数。全グループとも
 * これを経由する SSOT で、snapshot 入力に対する境界の振る舞いをここに閉じる。 */
export function parseMyWorkNodes(
  nodes: unknown[],
  kind: "pr" | "issue" | "mixed",
): GitMyWorkItem[] {
  return nodes.map((item) => ({
    kind: kind === "mixed" ? mixedNodeKind(item) : kind,
    repo: str(getPath(item, "repository", "nameWithOwner")),
    number: int(getPath(item, "number")),
    title: str(getPath(item, "title")),
    url: str(getPath(item, "url")),
    author: str(getPath(item, "author", "login")),
    authorAvatarUrl: str(getPath(item, "author", "avatarUrl")),
    updatedAt: str(getPath(item, "updatedAt")),
    isDraft: getPath(item, "isDraft") === true,
    checkState: checkState(getPath(item, "statusCheckRollup", "state"), "myWork"),
    reviewDecision: reviewDecision(getPath(item, "reviewDecision")),
    commentCount: commentCount(item),
  }));
}

/** `gh api user --jq .login` で認証中ユーザーの login を返す */
export async function viewer(dir: string): Promise<GhResult<string>> {
  const raw = await runGhCategorized(["api", "user", "--jq", ".login"], dir);
  if (!raw.ok) return raw;
  const login = raw.value.trim();
  if (login === "") {
    return { ok: false, error: { kind: "unauthenticated", detail: "empty login" } };
  }
  return { ok: true, value: login };
}

/** `RepoIdentity` を GhResult に正規化する適応層。失敗 detail 文字列を 1 箇所に集約し、
 * prList / issueList で文言が乖離しないようにする */
async function resolveGitHubRepoOrError(
  dir: string,
): Promise<GhResult<{ owner: string; repo: string }>> {
  const identity = await repoOwnerName(dir);
  if (identity.kind === "ok") {
    return { ok: true, value: { owner: identity.owner, repo: identity.repo } };
  }
  if (identity.kind === "unsetRemote") {
    return { ok: false, error: { kind: "repoNotFound", detail: "remote.origin not set" } };
  }
  // raw URL は credential 漏出防止のため detail に載せない（固定文言のみ）
  return { ok: false, error: { kind: "repoNotFound", detail: "unsupported remote URL" } };
}

// `-F` は型推論で number/bool を渡しうるため、string にしたい owner/repo/query は `-f` を使う。
// limit のみ Int として渡したいので `-F` で渡す
function graphqlArgs(owner: string, repo: string, query: string): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    "limit=100",
    "-f",
    `query=${query}`,
  ];
}

/** gh を実行し、non-zero exit を stderr 内容で GhError 4 種に分類して返す。
 * 解決失敗（gh CLI 未インストール = CommandNotFoundError 等）はそのまま throw して
 * 上位で HTTP error として renderer に流す */
async function runGhCategorized(args: string[], cwd: string): Promise<GhResult<string>> {
  return withResolvedCommand("gh", async (ghPath) => {
    const result = await tryCatch(
      execFileAsync(ghPath, args, { cwd, maxBuffer: 128 * 1024 * 1024 }),
    );
    if (result.ok) return { ok: true, value: result.value.stdout };
    const error = result.error as Error & { code?: number | string; stderr?: string };
    if (typeof error.code === "number") {
      const stderr = error.stderr ?? "";
      return {
        ok: false,
        error: { kind: classifyGhStderr(stderr), detail: truncateDetail(stderr) },
      };
    }
    throw result.error;
  });
}

/**
 * gh の stderr を 4 種類に分類する。マッチパターンは GitHub CLI の実出力に基づく。
 * 順序が重要: rate limit メッセージにも "API" 等の汎用語が含まれるため、
 * 特異度の高いパターンから順に評価する
 */
function classifyGhStderr(stderr: string): GhErrorKindName {
  const s = stderr.toLowerCase();
  if (s.includes("rate limit") || s.includes("api rate limit") || s.includes("secondary rate")) {
    return "rateLimit";
  }
  if (
    s.includes("authentication") ||
    s.includes("not authenticated") ||
    s.includes("could not authenticate") ||
    s.includes("bad credentials") ||
    s.includes("unauthorized")
  ) {
    return "unauthenticated";
  }
  if (
    s.includes("not found") ||
    s.includes("could not resolve to a repository") ||
    s.includes("repository not found")
  ) {
    return "repoNotFound";
  }
  if (
    s.includes("could not resolve host") ||
    s.includes("network is unreachable") ||
    s.includes("connection refused") ||
    s.includes("timeout") ||
    s.includes("dial tcp")
  ) {
    return "network";
  }
  return "other";
}

const DETAIL_MAX_BYTES = 512;

function truncateDetail(s: string): string {
  const trimmed = s.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= DETAIL_MAX_BYTES) return trimmed;
  // utf8 byte 境界で安全に切る（Buffer 切断は多バイト文字を壊すため文字単位で積む）
  let result = "";
  let bytes = 0;
  for (const char of trimmed) {
    const chunk = Buffer.byteLength(char, "utf8");
    if (bytes + chunk > DETAIL_MAX_BYTES) break;
    bytes += chunk;
    result += char;
  }
  return result;
}

// GraphQL 応答の defensive navigation。Swift 版の `as? [String: Any]` 連鎖に対応する。
// 応答 shape が想定と違っても throw せず ""/0/false に倒し、根 (nodes 配列不在) だけ
// GhError("unexpected response shape") として観察可能化する

function getPath(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}

/**
 * `GitPullRequest.commentCount` を組み立てる。数え方の定義は同フィールドの doc が SSOT。
 *
 * `totalCommentsCount` を使わないのは、本文を持つだけでインラインコメントを伴わないレビューを
 * 数え落とすため。CI / AI が要約レビューを 1 本投げる形（CodeRabbit 等）がまさにこの形で、
 * 「コメントが付いたこと」に気づくという用途に対して致命的に効かない。
 *
 * 本文の無い approve だけのレビューも 1 と数える。本文の有無は connection を辿らないと
 * 分からず、それは cost に乗るため。
 */
function commentCount(item: unknown): number {
  return (
    int(getPath(item, "comments", "totalCount")) +
    int(getPath(item, "reviews", "totalCount")) +
    int(getPath(item, "reviewThreads", "totalCount"))
  );
}

function isCheckState(v: unknown): v is GitPullRequestCheckState {
  return typeof v === "string" && (GIT_PULL_REQUEST_CHECK_STATES as readonly string[]).includes(v);
}

/**
 * rollup の state を検証する。表示側は undefined を「check が 1 つも無い」と読むため、
 * 値が来たのに未知だった場合はログを残してから undefined にする。黙って倒すと、GitHub が
 * enum を増やした瞬間に「CI 無し」という事実でない主張を polling のたびに出し続ける。
 *
 * `tag` は呼び出し元を示す観察ログのタグ。取得経路が複数あるため、どの query の応答で
 * 未知の enum が来たかを追えるようにする。
 */
function checkState(v: unknown, tag: string): GitPullRequestCheckState | undefined {
  if (v === null || v === undefined) return undefined;
  if (isCheckState(v)) return v;
  console.error(`[${tag}] unknown statusCheckRollup.state: ${JSON.stringify(v)}`);
  return undefined;
}

function isReviewDecision(v: unknown): v is GitPullRequestReviewDecision {
  return (
    typeof v === "string" && (GIT_PULL_REQUEST_REVIEW_DECISIONS as readonly string[]).includes(v)
  );
}

/**
 * `reviewDecision` を検証する。null は「レビュー設定が無い PR」を意味する正常値で、
 * 表示側も undefined をそう読む。未知の enum は `checkState` と同じ理由でログに残す。
 */
function reviewDecision(v: unknown): GitPullRequestReviewDecision | undefined {
  if (v === null || v === undefined) return undefined;
  if (isReviewDecision(v)) return v;
  console.error(`[myWork] unknown reviewDecision: ${JSON.stringify(v)}`);
  return undefined;
}

function logins(nodes: unknown, field: string): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => str(getPath(node, field))).filter((login) => login !== "");
}

function reviewerLogins(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => str(getPath(node, "requestedReviewer", "login")))
    .filter((login) => login !== "");
}

function nodesAt(rawJson: string, key: "pullRequests" | "issues"): unknown[] | undefined {
  const parsed = tryCatch(() => JSON.parse(rawJson) as unknown);
  if (!parsed.ok) return undefined;
  const nodes = getPath(parsed.value, "data", "repository", key, "nodes");
  return Array.isArray(nodes) ? nodes : undefined;
}

/**
 * remote URL から (owner, repo) を抽出する。host は `github.com` のみ受理し、
 * それ以外は undefined。`.git` 拡張子は剥がす。
 * `https://host/owner/repo` / `ssh://user@host/owner/repo` / scp 形式 `git@host:owner/repo` に対応
 */
export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  let host: string;
  let path: string;

  const schemeIndex = url.indexOf("://");
  if (schemeIndex >= 0) {
    const afterScheme = url.slice(schemeIndex + 3);
    const slash = afterScheme.indexOf("/");
    if (slash < 0) return undefined;
    let authority = afterScheme.slice(0, slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    // port 番号があれば剥がす (host:port)
    const colon = authority.indexOf(":");
    if (colon >= 0) authority = authority.slice(0, colon);
    host = authority;
    path = afterScheme.slice(slash + 1);
  } else {
    const colon = url.indexOf(":");
    if (colon < 0) return undefined;
    // scp 形式: git@host:owner/repo
    let authority = url.slice(0, colon);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    host = authority;
    path = url.slice(colon + 1);
  }

  if (host !== "github.com") return undefined;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (owner === "" || repo === "") return undefined;
  return { owner, repo };
}
