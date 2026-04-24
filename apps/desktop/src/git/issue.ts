import type { GitIssue } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { execGh, getOwnerRepo } from "./pr";

/**
 * gh api graphql で open な issue 一覧を取得する。
 * gh がインストールされていない / 認証されていない場合は null を返す。
 */

const AVATAR_SIZE = 64;

/** GraphQL レスポンスの issue ノード */
interface GqlIssueNode {
  number: number;
  title: string;
  url: string;
  author: { login: string; avatarUrl: string } | null;
  updatedAt: string;
  assignees: { nodes: Array<{ login: string }> };
}

interface GqlIssueResponse {
  data?: {
    repository?: {
      issues: { nodes: GqlIssueNode[] };
    };
  };
}

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    issues(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        author { login avatarUrl(size: ${AVATAR_SIZE}) }
        updatedAt
        assignees(first: 20) { nodes { login } }
      }
    }
  }
}`;

export async function getIssueList({ cwd }: { cwd: string }): Promise<GitIssue[] | null> {
  const ownerRepo = await getOwnerRepo({ cwd });
  if (!ownerRepo) return null;
  const { owner, repo } = ownerRepo;

  const ISSUE_LIMIT = 100;
  const result = await execGh({
    args: [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `limit=${ISSUE_LIMIT}`,
      "-f",
      `query=${ISSUE_QUERY}`,
    ],
    cwd,
  });
  if (!result.ok) return null;

  const parsed = tryCatch(() => JSON.parse(result.stdout) as GqlIssueResponse);
  if (!parsed.ok) return null;

  const repository = parsed.value.data?.repository;
  if (!repository) return null;

  return repository.issues.nodes.map(({ author, assignees, ...issue }) => ({
    ...issue,
    author: author?.login ?? "",
    authorAvatarUrl: author?.avatarUrl ?? "",
    assignees: assignees.nodes.map((a) => a.login),
  }));
}
