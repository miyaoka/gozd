import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";

/**
 * gh CLI で open な PR 一覧を取得する。
 * gh がインストールされていない / 認証されていない場合は空配列を返す。
 */
interface GhPrItem {
  number: number;
  url: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRepositoryOwner: { login: string };
}

export async function getPrList({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string>;
}): Promise<GitPullRequest[]> {
  const ownerResult = await tryCatch(
    Promise.resolve(Bun.$`gh repo view --json owner --jq '.owner.login'`.cwd(cwd).env(env).text()),
  );
  if (!ownerResult.ok) return [];
  const repoOwner = ownerResult.value.trim();

  const result = await tryCatch(
    Promise.resolve(
      Bun.$`gh pr list --state open --json number,url,headRefName,state,isDraft,headRepositoryOwner --limit 100`
        .cwd(cwd)
        .env(env)
        .text(),
    ),
  );
  if (!result.ok) return [];

  const parsed = tryCatch(() => JSON.parse(result.value) as GhPrItem[]);
  if (!parsed.ok) return [];

  // fork 由来の PR を除外（自リポジトリの owner と一致するもののみ）
  return parsed.value
    .filter((pr) => pr.headRepositoryOwner.login === repoOwner)
    .map(({ headRepositoryOwner: _, ...pr }) => pr);
}
