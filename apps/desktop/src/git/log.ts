import { tryCatch } from "@gozd/shared";
import type { GitCommit } from "@gozd/rpc";

/**
 * git log のフィールド区切り文字。
 * コミットメッセージに含まれる可能性が極めて低いランダム文字列。
 */
const FIELD_SEPARATOR = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb";

/** git log のレコード区切り文字 */
const RECORD_SEPARATOR = "YY8Obm-ZBSuUqkDjlkj0oKyFS20E7ejTzl-BWlQc";

const DEFAULT_MAX_COUNT = 200;

/**
 * リモートのデフォルトブランチ名を取得する。
 * origin/HEAD が設定されていればそこから取得。なければ undefined。
 */
async function resolveDefaultBranch(cwd: string): Promise<string | undefined> {
  const result = await tryCatch(
    new Response(
      Bun.spawn(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], { cwd }).stdout,
    ).text(),
  );
  if (!result.ok) return undefined;
  // "refs/remotes/origin/main" → "main"
  const branch = result.value.trim().replace("refs/remotes/origin/", "");
  return branch || undefined;
}

/**
 * 現在のブランチ名を取得する。detached HEAD の場合は undefined。
 */
async function resolveCurrentBranch(cwd: string): Promise<string | undefined> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd }).stdout).text(),
  );
  if (!result.ok) return undefined;
  const branch = result.value.trim();
  // detached HEAD の場合 "HEAD" が返る
  return branch && branch !== "HEAD" ? branch : undefined;
}

/**
 * ローカルrefが存在するか確認する。
 * worktree 環境ではデフォルトブランチのローカル ref が存在しない場合がある。
 */
async function localRefExists({ cwd, branch }: { cwd: string; branch: string }): Promise<boolean> {
  const result = await tryCatch(
    new Response(
      Bun.spawn(["git", "rev-parse", "--verify", `refs/heads/${branch}`], { cwd }).stdout,
    ).text(),
  );
  return result.ok && result.value.trim() !== "";
}

/**
 * リモートrefが存在するか確認し、存在すれば "origin/{branch}" を返す。
 */
async function resolveRemoteRef({
  cwd,
  branch,
}: {
  cwd: string;
  branch: string;
}): Promise<string | undefined> {
  const ref = `origin/${branch}`;
  const result = await tryCatch(
    new Response(
      Bun.spawn(["git", "rev-parse", "--verify", `refs/remotes/${ref}`], {
        cwd,
      }).stdout,
    ).text(),
  );
  // コマンド失敗時も stdout 読み取りは成功するため、出力内容で判定する
  if (!result.ok || !result.value.trim()) return undefined;
  return ref;
}

/**
 * 現在のブランチとデフォルトブランチのコミット履歴を取得する。
 * current ブランチとデフォルトブランチのリモートrefも対象に含め、
 * リモートが先行している場合もグラフに表示する。
 * date-order で時系列ソートして返す。
 */
export async function getGitLog({
  cwd,
  maxCount,
  firstParentOnly,
}: {
  cwd: string;
  maxCount?: number;
  firstParentOnly?: boolean;
}): Promise<{ commits: GitCommit[]; defaultBranch?: string }> {
  const count = Math.min(maxCount ?? DEFAULT_MAX_COUNT, DEFAULT_MAX_COUNT);
  const format = ["%H", "%P", "%aN", "%at", "%s", "%D"].join(FIELD_SEPARATOR);
  const [defaultBranch, currentBranch] = await Promise.all([
    resolveDefaultBranch(cwd),
    resolveCurrentBranch(cwd),
  ]);
  // current と default のリモートrefを並列で解決
  const branchesToCheck = new Set(
    [currentBranch, defaultBranch].filter((b): b is string => b !== undefined),
  );
  const remoteRefs = await Promise.all(
    [...branchesToCheck].map((branch) => resolveRemoteRef({ cwd, branch })),
  );

  // defaultBranch のローカル ref 存在確認（worktree ではローカルに存在しない場合がある）
  const hasLocalDefault =
    defaultBranch !== undefined && (await localRefExists({ cwd, branch: defaultBranch }));

  const refs = ["HEAD"];
  if (hasLocalDefault) refs.push(defaultBranch);
  for (const remoteRef of remoteRefs) {
    if (remoteRef) refs.push(remoteRef);
  }

  const args = [
    "git",
    "log",
    `--format=${RECORD_SEPARATOR}${format}`,
    "--date-order",
    `--max-count=${count}`,
  ];
  if (firstParentOnly) args.push("--first-parent");
  args.push(...refs, "--");

  const result = await tryCatch(new Response(Bun.spawn(args, { cwd }).stdout).text());

  if (!result.ok) return { commits: [], defaultBranch };

  return { commits: parseGitLog(result.value), defaultBranch };
}

function parseGitLog(output: string): GitCommit[] {
  if (!output.trim()) return [];

  const records = output.split(RECORD_SEPARATOR).filter(Boolean);
  const commits: GitCommit[] = [];

  for (const record of records) {
    const fields = record.trim().split(FIELD_SEPARATOR);
    if (fields.length < 6) continue;

    const [hash, parentStr, author, dateStr, message, refStr] = fields;
    if (!hash || !author || !dateStr || message === undefined) continue;

    const parents = parentStr ? parentStr.split(" ").filter(Boolean) : [];
    const date = Number.parseInt(dateStr, 10);
    if (Number.isNaN(date)) continue;

    const refs = refStr ? parseRefs(refStr) : [];

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author,
      date,
      message,
      refs,
    });
  }

  return commits;
}

/**
 * git log の %D 出力（"HEAD -> main, origin/main, tag: v1.0"）をパースする。
 * "HEAD -> branch" は "HEAD" と "branch" に分解する。
 */
function parseRefs(refStr: string): string[] {
  if (!refStr.trim()) return [];

  const refs: string[] = [];
  const parts = refStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (!part) continue;
    // "HEAD -> main" を "HEAD" と "main" に分解
    const arrowMatch = part.match(/^HEAD -> (.+)$/);
    if (arrowMatch) {
      refs.push("HEAD");
      refs.push(arrowMatch[1]);
    } else {
      // "tag: v1.0" → "v1.0" に整形
      const tagMatch = part.match(/^tag: (.+)$/);
      refs.push(tagMatch ? `tag:${tagMatch[1]}` : part);
    }
  }

  return refs;
}
