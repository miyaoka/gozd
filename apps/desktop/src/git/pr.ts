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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    return { ok: false, stderr: stderr.trim() };
  }
  return { ok: true, stdout };
}

export async function getPrList({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string>;
}): Promise<GitPullRequest[]> {
  const ownerResult = await execGh({
    args: ["repo", "view", "--json", "owner", "--jq", ".owner.login"],
    cwd,
    env,
  });
  if (!ownerResult.ok) return [];
  const repoOwner = ownerResult.stdout.trim();

  const listResult = await execGh({
    args: [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,url,headRefName,state,isDraft,headRepositoryOwner",
      "--limit",
      "100",
    ],
    cwd,
    env,
  });
  if (!listResult.ok) return [];

  const parsed = tryCatch(() => JSON.parse(listResult.stdout) as GhPrItem[]);
  if (!parsed.ok) return [];

  // fork 由来の PR を除外（自リポジトリの owner と一致するもののみ）
  return parsed.value
    .filter((pr) => pr.headRepositoryOwner.login === repoOwner)
    .map(({ headRepositoryOwner: _, ...pr }) => pr);
}
