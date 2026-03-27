import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";

/**
 * gh api graphql で open な PR 一覧を取得する。
 * gh がインストールされていない / 認証されていない場合は null を返す。
 */

const AVATAR_SIZE = 64;

/** GraphQL レスポンスの PR ノード */
interface GqlPrNode {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: { login: string; avatarUrl: string } | null;
  updatedAt: string;
  headRepository: { owner: { login: string } } | null;
  assignees: { nodes: Array<{ login: string }> };
  reviewRequests: { nodes: Array<{ requestedReviewer: { login: string } | null }> };
}

interface GqlPrResponse {
  data?: {
    repository?: {
      owner: { login: string };
      pullRequests: { nodes: GqlPrNode[] };
    };
  };
}

const PR_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    owner { login }
    pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        headRefName
        state
        isDraft
        author { login avatarUrl(size: ${AVATAR_SIZE}) }
        updatedAt
        headRepository { owner { login } }
        assignees(first: 20) { nodes { login } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
      }
    }
  }
}`;

/**
 * Bun.spawn で gh コマンドを実行し、stdout を文字列で返す。
 * Bun.$ は .env() で渡した PATH をコマンド解決に使わない（process.env.PATH を参照する）ため、
 * build 版で gh が見つからない問題がある。Bun.spawn なら env.PATH でコマンド解決される。
 */
async function execGh({
  args,
  cwd,
  env,
}: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  const spawnResult = tryCatch(() =>
    Bun.spawn(["gh", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" }),
  );
  if (!spawnResult.ok) {
    return { ok: false, stderr: String(spawnResult.error) };
  }
  const proc = spawnResult.value;
  const readResult = await tryCatch(
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
  );
  // ストリーム読み取り失敗でもプロセス終了を保証する
  await proc.exited;
  if (!readResult.ok) {
    return { ok: false, stderr: String(readResult.error) };
  }
  const [stdout, stderr] = readResult.value;
  if (proc.exitCode !== 0) {
    return { ok: false, stderr: stderr.trim() };
  }
  return { ok: true, stdout };
}

/** 自アカウントのログイン名キャッシュ（成功時のみ保持） */
let cachedViewer: string | undefined;

export async function getViewer({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string>;
}): Promise<string | null> {
  if (cachedViewer !== undefined) return cachedViewer;
  const result = await execGh({ args: ["api", "user", "--jq", ".login"], cwd, env });
  if (!result.ok) return null;
  const login = result.stdout.trim();
  cachedViewer = login;
  return login;
}

export async function getPrList({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string>;
}): Promise<GitPullRequest[] | null> {
  // owner/repo を取得
  const nameResult = await execGh({
    args: ["repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name'],
    cwd,
    env,
  });
  if (!nameResult.ok) return null;
  const [owner, repo] = nameResult.stdout.trim().split("/");
  if (!owner || !repo) return null;

  const PR_LIMIT = 100;
  const result = await execGh({
    args: [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `limit=${PR_LIMIT}`,
      "-f",
      `query=${PR_QUERY}`,
    ],
    cwd,
    env,
  });
  if (!result.ok) return null;

  const parsed = tryCatch(() => JSON.parse(result.stdout) as GqlPrResponse);
  if (!parsed.ok) return null;

  // GraphQL の partial error や null レスポンスをガード
  const repository = parsed.value.data?.repository;
  if (!repository) return null;
  const { owner: repoOwner, pullRequests } = repository;

  // fork 由来の PR を除外（自リポジトリの owner と一致するもののみ）
  return pullRequests.nodes
    .filter((pr) => pr.headRepository?.owner.login === repoOwner.login)
    .map(({ headRepository: _, author, assignees, reviewRequests, ...pr }) => ({
      ...pr,
      author: author?.login ?? "",
      authorAvatarUrl: author?.avatarUrl ?? "",
      assignees: assignees.nodes.map((a) => a.login),
      reviewers: reviewRequests.nodes
        .map((r) => r.requestedReviewer?.login)
        .filter((login): login is string => login !== undefined),
    }));
}
