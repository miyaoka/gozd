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
  GitItemKind,
  GitMyWorkAxisKey,
  GitMyWorkGroup,
  GitMyWorkItem,
  GitMyWorkWebLink,
  GitPullRequest,
  GitPullRequestBadge,
  GitPullRequestCheckState,
  GitPullRequestReviewDecision,
  GitPullRequestStack,
} from "@gozd/rpc";
import {
  GIT_MY_WORK_AXIS_KEYS,
  GIT_PULL_REQUEST_CHECK_STATES,
  GIT_PULL_REQUEST_REVIEW_DECISIONS,
} from "@gozd/rpc";
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

// 1 stack から取る entry の上限。現実的な stack の深さを超える値にしておけば base 端を取り逃さない。
const STACK_ENTRY_LIMIT = 50;

/** trunk に最も近い entry の position。 */
const STACK_BOTTOM_POSITION = 1;

/**
 * 消費した point を応答自身に載せる field。connection ではないため cost に乗らず、常設できる。
 */
export const RATE_LIMIT_FIELD = "rateLimit { cost remaining }";

/**
 * 観察ログの 1 行を組み立てる。
 *
 * `cost` / `remaining` を 0 に倒さない。契約は docs/git.md の「観察可能性」節。
 */
export function formatGhCostLine(parsed: unknown, tag: string, detail = ""): string {
  const cost = getPath(parsed, "data", "rateLimit", "cost");
  const remaining = getPath(parsed, "data", "rateLimit", "remaining");
  if (typeof cost !== "number" || typeof remaining !== "number") {
    return `[${tag}] rateLimit missing in response`;
  }
  return [`[${tag}]`, `cost=${cost}`, `remaining=${remaining}`, detail]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * gh の応答を 1 度だけ parse する。**観察ログはここで出す。**
 *
 * 応答を各所で parse し直すと、同じ文字列を何度も読み直すうえに「消費を記録したか」が
 * 呼び出しごとの作法になる。取得の入口を 1 本にして、parse とログをそこに閉じる。
 */
function parseGhResponse(tag: string, rawJson: string, detail = ""): GhResult<unknown> {
  const parsed = tryCatch(() => JSON.parse(rawJson) as unknown);
  if (!parsed.ok) {
    // 読めなかったのは rateLimit ではなく応答全体。以降の取り出しも必ず失敗する
    console.error(`[${tag}] response unreadable: ${parsed.error}`);
    return { ok: false, error: { kind: "other", detail: "unreadable response" } };
  }
  console.error(formatGhCostLine(parsed.value, tag, detail));
  return { ok: true, value: parsed.value };
}

/**
 * バッジ取得 1 往復あたりの branch 数。
 *
 * cost は branch 数に比例して伸びる（下のコスト式を参照）。100 を単位にする理由は cost ではなく、
 * グラフに載る ref が git log の取得窓（`maxCount`）に由来して高々数百本であり、100 なら
 * 1〜数往復で収まるため。
 */
const BADGE_BRANCH_CHUNK = 100;

// GraphQL の rate limit cost は「各 connection を満たすのに必要な request 数の合計を 100 で割って
// 四捨五入（最小 1）」。**connection 1 つの request 数は親ノード数**（祖先の `first` の積）で決まり、
// 返ってきた件数では決まらない。自分の `first` は自分の request 数には掛からず、子の親ノード数を
// 決めるだけ。
//
// バッジ query は「alias N 本（親は repository の 1 ノード）= N」＋「各 PR 直下の `stack.entries`
// （親は N×窓 の PR ノード）= N×窓」で **N×(1+窓)**。窓 3 の実測は 10 本 1 / 47 本 2 / 55 本 2 /
// 80 本 3 / 100 本 4 で、窓 30・100 本の 31 まで含めて式と一致する。
//
// **cost を削るノブは `BADGE_PR_WINDOW`**。request 数の 3/4 を `stack.entries` が占めるが、その数は
// 窓に比例し `STACK_ENTRY_LIMIT` には依存しない。上限を下げても cost は動かない。
//
// `statusCheckRollup` は connection ではないため乗らない。CI 結果を `commits(last: 1)` 経由で
// 取ると connection が 1 つ増えるので、PullRequest 直下の rollup を使う。connection の
// `totalCount` も `first` / `last` を渡さなければページを要求しないため乗らない。
const PR_BADGE_FRAGMENT = `
fragment badge on PullRequest {
  number
  url
  isDraft
  headRefName
  baseRefOid
  headRepository { owner { login } }
  statusCheckRollup { state }
  comments { totalCount }
  reviews { totalCount }
  reviewThreads { totalCount }
  stackEntry { position }
  stack {
    number
    size
    entries(first: ${STACK_ENTRY_LIMIT}) { nodes { position pullRequest { baseRefOid } } }
  }
}`;

/**
 * 1 branch あたりに引く open PR の数。
 *
 * **1 では足りない。**`headRefName` の絞り込みは base repo の PR を返すため fork の同名 branch も
 * 含み、取得後に head owner で捨てる。窓が 1 だと、捨てられる PR 1 件で窓が埋まった瞬間に
 * 自 repo の PR が見えなくなり、「PR を持たない branch」と区別が付かなくなる。
 *
 * 窓は「捨てうる数 + 1」以上が要る。gh CLI は 1 branch を単独で引くため 30、VS Code の GitHub PR
 * 拡張は 3 を使う。gozd は N branch を 1 往復に束ねるので cost が N×(1+窓) で効き（実測: N=100 で
 * 窓 3 なら cost 4、窓 30 なら 31）、束ね取得で成立する 3 を採る。
 */
export const BADGE_PR_WINDOW = 3;

/**
 * 指定した branch に紐づく open PR を 1 往復で引く query を組み立てる。
 *
 * branch 名は変数で渡す。query 文字列へ埋め込むと、名前に引用符やバックスラッシュが入った
 * 瞬間に GraphQL の構文が壊れる（`MY_WORK_QUERY` の軸と同じ規律）。
 *
 * 同じ head を持つ open PR は複数あり得るので、どれを取るかを `orderBy` で固定する。
 */
export function badgeQuery(count: number): string {
  // 0 本だと変数宣言が空になり、末尾のカンマで構文が壊れた query を返す。引く branch が無いのは
  // 呼び出し側のバグなので、壊れた成果物を静かに返さず invariant 違反として落とす
  if (count < 1) throw new Error(`badgeQuery: count must be >= 1, got ${count}`);
  const decl = Array.from({ length: count }, (_, i) => `$b${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) =>
      `    b${i}: pullRequests(headRefName: $b${i}, first: ${BADGE_PR_WINDOW}, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...badge } }`,
  ).join("\n");
  return `
query($owner: String!, $repo: String!, ${decl}) {
  ${RATE_LIMIT_FIELD}
  repository(owner: $owner, name: $repo) {
${fields}
  }
}
${PR_BADGE_FRAGMENT}`;
}

// picker の行が描くものだけ。バッジ用の fragment は取り込まない。
//
// fork 判定は remote URL から local に解決した owner で行うため、query が持つ owner は head 側だけ。
// `assignees` / `reviewRequests` は picker の絞り込みが参照するのでここに含める。
//
// cost は 1（pullRequests）+ 100（assignees）+ 100（reviewRequests）= 201 → **2**（実測 2）。
//
// `statusCheckRollup` と会話数は cost を増やさないが、100 件ぶんを GitHub が解決するため応答が
// 1.6 秒伸びる（実測）。picker はどちらも描かないので、載せると描かないものを待つことになる。
export const PR_LIST_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  ${RATE_LIMIT_FIELD}
  repository(owner: $owner, name: $repo) {
    pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        headRefName
        updatedAt
        headRepository { owner { login } }
        author { login avatarUrl(size: ${AVATAR_SIZE}) }
        assignees(first: 100) { nodes { login } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
      }
    }
  }
}`;

export const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  ${RATE_LIMIT_FIELD}
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

/**
 * 指定した branch に紐づく open PR。グラフのバッジが使う取得経路。
 *
 * **消費が repo の PR 総数から切り離される。**引く branch の数だけで決まり、一覧を取ってから
 * 突き合わせる形のように「上限で切れて PR を持たない branch と区別が付かない」状態が起こらない。
 *
 * **branch ごとに最大 1 件**へ畳んで返す。窓を広く取るのは fork を捨てるための内部都合なので、
 * 複数件を呼び出し側へ流さない。
 */
export async function prsForBranches(
  dir: string,
  branches: string[],
): Promise<GhResult<GitPullRequestBadge[]>> {
  if (branches.length === 0) return { ok: true, value: [] };
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;

  const prs: GitPullRequestBadge[] = [];
  // 直列に撃つ。GitHub は secondary rate limit を避けるため並列ではなく直列を推奨している
  for (let start = 0; start < branches.length; start += BADGE_BRANCH_CHUNK) {
    const chunk = await badgePrsForChunk(dir, owner, repo, branches, start);
    if (!chunk.ok) {
      // 完走した往復の結果はここで捨てられる。呼び出し側は要求した全 branch の鮮度を進めるため、
      // 取れていた PR が次の窓まで「PR 無し」と同じ見た目になる。失敗の脱出はこの 1 点だけに
      // 置く。分岐ごとに告知を書くと、片方だけ無音のまま残る
      if (prs.length > 0) {
        console.error(
          `[prsForBranches] discarding ${prs.length} prs from completed chunks: chunk at ${start} failed kind=${chunk.error.kind} detail=${chunk.error.detail}`,
        );
      }
      return chunk;
    }
    prs.push(...chunk.value);
  }
  return { ok: true, value: newestPerBranch(prs) };
}

/**
 * バッジ取得の 1 往復。`start` から `BADGE_BRANCH_CHUNK` 本ぶんの branch を 1 つの query に束ねる。
 *
 * 失敗の種別を呼び出し側へそのまま返す。ここで告知すると、完走した往復をいくつ捨てたかを
 * 知らないまま書くことになる。
 */
async function badgePrsForChunk(
  dir: string,
  owner: string,
  repo: string,
  branches: string[],
  start: number,
): Promise<GhResult<GitPullRequestBadge[]>> {
  const chunk = branches.slice(start, start + BADGE_BRANCH_CHUNK);
  const args = [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    ...chunk.flatMap((branch, i) => ["-f", `b${i}=${branch}`]),
    "-f",
    `query=${badgeQuery(chunk.length)}`,
  ];
  const raw = await runGhCategorized(args, dir);
  if (!raw.ok) return raw;
  const parsed = parseGhResponse("prsForBranches", raw.value, `branches=${chunk.length}`);
  if (!parsed.ok) return parsed;
  const nodes = aliasedNodes(parsed.value, chunk.length);
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  return { ok: true, value: parsePullRequestBadgeNodes(nodes, owner) };
}

/**
 * branch ごとに 1 件だけ残す。node は alias 順・alias 内 `CREATED_AT DESC` 順で並ぶので、
 * **先勝ちが最新**になる。
 *
 * 窓を 1 より広く取るのは fork を捨てても自 repo の PR が残るようにするための内部都合で、
 * 呼び出し側は 1 branch につき 1 個のバッジしか描かない。畳まずに流すと、受け側が Map へ
 * 詰めた時点で後勝ち = 最古が選ばれる。
 */
export function newestPerBranch(prs: GitPullRequestBadge[]): GitPullRequestBadge[] {
  const seen = new Set<string>();
  return prs.filter((pr) => {
    if (seen.has(pr.headRef)) return false;
    seen.add(pr.headRef);
    return true;
  });
}

/** alias `b0..b{count-1}` の nodes を 1 本に潰す。1 つでも欠けていれば応答形式の異常。 */
export function aliasedNodes(parsed: unknown, count: number): unknown[] | undefined {
  const nodes: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const alias = getPath(parsed, "data", "repository", `b${i}`, "nodes");
    if (!Array.isArray(alias)) return undefined;
    nodes.push(...alias);
  }
  return nodes;
}

/**
 * open PR 一覧の 1 ページ。PR picker が「選ばせる母集合」として使う経路で、定期取得はしない。
 *
 * 1 往復で先頭 100 件（connection の上限）を返す。
 */
export async function prList(dir: string): Promise<GhResult<GitPullRequest[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, PR_LIST_QUERY), dir);
  if (!raw.ok) return raw;
  const parsed = parseGhResponse("prList", raw.value);
  if (!parsed.ok) return parsed;
  const nodes = nodesAt(parsed.value, "pullRequests");
  if (nodes === undefined) {
    return { ok: false, error: { kind: "other", detail: "unexpected response shape" } };
  }
  return { ok: true, value: parsePullRequestNodes(nodes, owner) };
}

/**
 * PR node をバッジの範囲へ変換する pure 関数。バッジ経路の変換をここに閉じ、snapshot 入力に
 * 対する境界の振る舞いを 1 箇所で決める。
 *
 * fork PR（head owner ≠ local owner）は除外する: worktree 作成側が `origin/<headRef>` を
 * startPoint に使うため、fork からの PR は ref 解決に失敗する。`owner` は remote URL から
 * local に解決した値を渡す。`headRefName` での絞り込みは fork の同名 branch も拾うため、
 * バッジ経路でも同じ除外が要る。
 */
export function parsePullRequestBadgeNodes(nodes: unknown[], owner: string): GitPullRequestBadge[] {
  const prs: GitPullRequestBadge[] = [];
  for (const item of nodes) {
    const headOwner = str(getPath(item, "headRepository", "owner", "login"));
    if (headOwner !== owner) continue;
    prs.push({
      number: int(getPath(item, "number")),
      url: str(getPath(item, "url")),
      headRef: str(getPath(item, "headRefName")),
      isDraft: getPath(item, "isDraft") === true,
      baseRefOid: str(getPath(item, "baseRefOid")),
      checkState: checkState(getPath(item, "statusCheckRollup", "state"), "prsForBranches"),
      commentCount: commentCount(item),
      stack: parseStack(item),
    });
  }
  return prs;
}

/**
 * PR 一覧 query の nodes を picker の範囲へ変換する。fork PR の除外はバッジ経路と同じ理由
 * （worktree 作成が `origin/<headRef>` を startPoint に使うため、fork では ref 解決に失敗する）。
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
      headRef: str(getPath(item, "headRefName")),
      isDraft: getPath(item, "isDraft") === true,
      author: str(getPath(item, "author", "login")),
      authorAvatarUrl: str(getPath(item, "author", "avatarUrl")),
      assignees: logins(getPath(item, "assignees", "nodes"), "login"),
      reviewers: reviewerLogins(getPath(item, "reviewRequests", "nodes")),
      updatedAt: str(getPath(item, "updatedAt")),
    });
  }
  return prs;
}

/**
 * PR node の stack 情報を変換する。stack に属さない PR は `stack` が null で来る。
 *
 * base 端の OID は position 1 の PR の `baseRefOid` から取る。`PullRequestStack` は OID を返す
 * field を持たず、ref 名から引くには PR ごとに名前が変わる query が要って単一 query に載らない。
 * 順序を保証する記述が schema に無いため、先頭要素ではなく position 1 を明示的に探す。
 */
function parseStack(item: unknown): GitPullRequestStack | undefined {
  const stack = getPath(item, "stack");
  if (typeof stack !== "object" || stack === null) return undefined;

  const number = int(getPath(stack, "number"));
  const position = int(getPath(item, "stackEntry", "position"));
  const baseRefOid = stackBaseRefOid(getPath(stack, "entries", "nodes"));
  // 誤った起点で差分を出すより stack なしに倒す。無音だと「stack なのに toggle が出ない」が
  // 診断不能になるためログは残す。
  if (position === 0 || baseRefOid === "") {
    console.error(
      `[parseStack] incomplete stack: stackNumber=${number} position=${position} baseRefOid='${baseRefOid}'`,
    );
    return undefined;
  }

  return {
    size: int(getPath(stack, "size")),
    position,
    baseRefOid,
  };
}

/** stack 全体の base commit OID。解決できないときは空文字。 */
function stackBaseRefOid(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "";
  const bottom = nodes.find((node) => int(getPath(node, "position")) === STACK_BOTTOM_POSITION);
  return str(getPath(bottom, "pullRequest", "baseRefOid"));
}

/** open issue 一覧 */
export async function issueList(dir: string): Promise<GhResult<GitIssue[]>> {
  const identity = await resolveGitHubRepoOrError(dir);
  if (!identity.ok) return identity;
  const { owner, repo } = identity.value;
  const raw = await runGhCategorized(graphqlArgs(owner, repo, ISSUE_QUERY), dir);
  if (!raw.ok) return raw;
  const parsed = parseGhResponse("issueList", raw.value);
  if (!parsed.ok) return parsed;
  const nodes = nodesAt(parsed.value, "issues");
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

interface MyWorkSearch {
  kind: GitItemKind | "mixed";
  query: string;
}

/**
 * 軸ごとの検索条件。**GraphQL の取得と GitHub 上の一覧 URL は同じ定義から導出する** —
 * 別々に書くと、リンク先が一覧と違う母集合を出すようになる。
 *
 * 軸の集合と並びは `GIT_MY_WORK_AXIS_KEYS` が持ち、ここは軸ごとの検索条件だけを持つ。
 * Record の鍵付けにより、軸の増減・改名・キー重複はここが compile error で追従を要求する。
 * 走査は list 側で行うため、この Record の記述順は何にも影響しない。
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
const MY_WORK_SEARCHES: Record<GitMyWorkAxisKey, MyWorkSearch> = {
  authoredIssues: {
    kind: "issue",
    query: "is:open is:issue author:@me archived:false sort:updated-desc",
  },
  authoredPrs: {
    kind: "pr",
    query: "is:open is:pr author:@me archived:false sort:updated-desc",
  },
  mentioned: {
    kind: "mixed",
    query: "is:open mentions:@me archived:false sort:updated-desc",
  },
  reviewRequestedPrs: {
    kind: "pr",
    query: "is:open is:pr review-requested:@me archived:false sort:updated-desc",
  },
};

/**
 * kind → `nodes` に展開する selection。mixed は union（`Issue | PullRequest`）の両型を受け、
 * 行の種別を `__typename` で判定するため mixed だけがそれを要求する。
 */
const MY_WORK_NODE_SELECTIONS = {
  pr: "...prFields",
  issue: "...issueFields",
  mixed: "__typename ...prFields ...issueFields",
} as const;

/** 軸キー → 取得結果。ワイヤの `groups` と同型で、軸の網羅は `MY_WORK_SEARCHES` の
 * Record 鍵付けが compile error で保証する。 */
export type MyWork = Record<GitMyWorkAxisKey, GitMyWorkGroup>;

/** GitHub の検索ページの種別。PR と issue でタブが分かれており、issue の検索は
 * `is:pr` を受け付けない */
const KIND_WEB_TYPE = { pr: "pullrequests", issue: "issues" } as const;

/**
 * 同じ検索条件を GitHub の検索ページで開くリンク。検索ページには混在を 1 ページに出す
 * 種別が無いため、mixed 軸は種別タブごとに 1 本ずつ出す。query は共通なので、全リンクの
 * 母集合の和が一覧の母集合と一致する。
 */
function myWorkWebLinks(search: MyWorkSearch): GitMyWorkWebLink[] {
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
 * 要求しないので同じく乗らない（PR_QUERY 冒頭のコメントと同じ規律）。`issueCount` と
 * `isReadByViewer` も同様。
 *
 * 未読を「最終コメントの投稿者が自分以外か」で導出しない。`comments(last: 1)` は node ごとに
 * ページを要求するため cost が軸数ぶん跳ね（4 軸で 1 → 4 を実測）、bot のコメントも拾ううえ、
 * 見たかどうかを表せない。`isReadByViewer` は GitHub が viewer ごとに持つ既読状態そのもので、
 * スカラーなので cost を増やさずに同じ問いへ直接答える。
 *
 * 取得上限で切れているかどうかを示すのに `pageInfo { hasNextPage }` を併載しないのは、
 * `issueCount` と取得件数の比較で同じ事実が得られ、境界に同じ事実の表現を 2 つ持たせない
 * ため。
 *
 * 検索条件は変数で渡す。query 文字列に埋め込むと、条件に引用符が入った瞬間に GraphQL の
 * 構文を壊す。
 *
 * 軸ごとの変数宣言と search エイリアスは `GIT_MY_WORK_AXIS_KEYS` の走査で組み立てる。
 * 手書きで並べると軸の一覧が 2 箇所に存在し、片方だけ足した状態を作れてしまう（未宣言の
 * 変数はサーバー側で無視されるため、取得は「その軸が応答に無い」形で落ちる）。
 */
export const MY_WORK_QUERY = `
query($limit: Int!, ${GIT_MY_WORK_AXIS_KEYS.map((key) => `$${key}: String!`).join(", ")}) {
  ${RATE_LIMIT_FIELD}
${GIT_MY_WORK_AXIS_KEYS.map(
  (key) => `  ${key}: search(type: ISSUE, query: $${key}, first: $limit) {
    issueCount
    nodes { ${MY_WORK_NODE_SELECTIONS[MY_WORK_SEARCHES[key].kind]} }
  }`,
).join("\n")}
}

fragment prFields on PullRequest {
  number
  title
  url
  isDraft
  isReadByViewer
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
  isReadByViewer
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
    ...GIT_MY_WORK_AXIS_KEYS.flatMap((key) => ["-f", `${key}=${MY_WORK_SEARCHES[key].query}`]),
    "-f",
    `query=${MY_WORK_QUERY}`,
  ];
  const raw = await runGhCategorized(args, homedir());
  if (!raw.ok) return raw;
  const parsed = parseGhResponse("myWork", raw.value);
  if (!parsed.ok) return parsed;
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
  for (const key of GIT_MY_WORK_AXIS_KEYS) {
    const nodes = getPath(response, "data", key, "nodes");
    if (!Array.isArray(nodes)) {
      return { ok: false, error: { kind: "other", detail: `missing nodes: ${key}` } };
    }
    const totalCount = getPath(response, "data", key, "issueCount");
    if (typeof totalCount !== "number") {
      return { ok: false, error: { kind: "other", detail: `missing issueCount: ${key}` } };
    }
    result[key] = {
      items: parseMyWorkNodes(nodes, MY_WORK_SEARCHES[key].kind),
      totalCount,
      webLinks: myWorkWebLinks(MY_WORK_SEARCHES[key]),
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
  for (const key of GIT_MY_WORK_AXIS_KEYS) {
    result[key] = { items: [], totalCount: 0, webLinks: myWorkWebLinks(MY_WORK_SEARCHES[key]) };
  }
  return result;
}

/**
 * mixed 軸の行種別。`search(type: ISSUE)` の union は `Issue | PullRequest` の 2 型。
 * 未知の型名は観察ログを残し、フィールドが両型の共通部分である issue に倒す。
 */
function mixedNodeKind(item: unknown): GitItemKind {
  const typename = getPath(item, "__typename");
  if (typename === "PullRequest") return "pr";
  if (typename !== "Issue") {
    console.error(`[myWork] unknown __typename: ${JSON.stringify(typename)}`);
  }
  return "issue";
}

/** my work query の nodes を `GitMyWorkItem` へ変換する pure 関数。全グループとも
 * これを経由する SSOT で、snapshot 入力に対する境界の振る舞いをここに閉じる。 */
export function parseMyWorkNodes(nodes: unknown[], kind: GitItemKind | "mixed"): GitMyWorkItem[] {
  // 既読状態が取れなかった件数。行ごとに出すと 1 応答で 100 行ぶん流れるため集計して 1 行にする
  let missingReadState = 0;

  const items = nodes.map((item) => {
    const readState = getPath(item, "isReadByViewer");
    if (typeof readState !== "boolean") missingReadState += 1;

    return {
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
      // 欠落時は既読側へ倒す。未読は注意を促す表示なので、取得できていない事実を
      // 「未読がある」と描くと実在しない要対応を作り出す
      isUnread: readState === false,
    };
  });

  // 全件が既読側へ倒れると「未読が無い」と区別できなくなる。取れなかったことを残す
  if (missingReadState > 0) {
    console.error(`[myWork] missing isReadByViewer: ${missingReadState}/${nodes.length} nodes`);
  }
  return items;
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

function nodesAt(parsed: unknown, key: "pullRequests" | "issues"): unknown[] | undefined {
  const nodes = getPath(parsed, "data", "repository", key, "nodes");
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
