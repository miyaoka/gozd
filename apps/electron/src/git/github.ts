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

import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
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

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  assignees: string[];
  reviewers: string[];
  updatedAt: string;
  authorAvatarUrl: string;
  /** base branch の commit OID。PR diff 表示モードで base 端を識別する SSOT */
  baseRefOid: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  authorAvatarUrl: string;
}

export type GhResult<T> = { ok: true; value: T } | { ok: false; error: GhError };

// GitHub の avatar 画像サイズ（px）。PR/Issue picker 行の表示サイズに合わせる
const AVATAR_SIZE = 64;

// `owner { login }` は廃止（fork 判定にはローカルで parse した owner を使う）。
// `assignees` / `reviewRequests` は PR picker の filter 機能で参照するため一覧 query に含める
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

/** open PR 一覧。fork PR（head owner ≠ local owner）は除外する: worktree 作成側が
 * `origin/<headRef>` を startPoint に使うため、fork からの PR は ref 解決に失敗する */
export async function prList(dir: string): Promise<GhResult<PullRequestInfo[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, PR_QUERY), dir);
  if (!raw.ok) return raw;
  const nodes = nodesAt(raw.value, "pullRequests");
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  const prs: PullRequestInfo[] = [];
  for (const item of nodes) {
    // fork PR を除外（owner は repoOwnerName で local に得たものを SSOT として使う）
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
    });
  }
  return { ok: true, value: prs };
}

/** open issue 一覧 */
export async function issueList(dir: string): Promise<GhResult<IssueInfo[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, ISSUE_QUERY), dir);
  if (!raw.ok) return raw;
  const nodes = nodesAt(raw.value, "issues");
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  const issues: IssueInfo[] = nodes.map((item) => ({
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
