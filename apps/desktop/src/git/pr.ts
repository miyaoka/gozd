import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";

/**
 * gh CLI で open な PR 一覧を取得する。
 * gh がインストールされていない / 認証されていない場合は空配列を返す。
 */
export async function getPrList(cwd: string): Promise<GitPullRequest[]> {
  const result = await tryCatch(
    Bun.$`gh pr list --state open --json number,url,headRefName,state,isDraft --limit 100`
      .cwd(cwd)
      .text(),
  );
  if (!result.ok) return [];

  const parsed = await tryCatch(Promise.resolve(JSON.parse(result.value) as GitPullRequest[]));
  if (!parsed.ok) return [];

  return parsed.value;
}
