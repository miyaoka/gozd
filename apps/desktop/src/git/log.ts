import { tryCatch } from "@gozd/shared";
import type { GitCommit } from "@gozd/rpc";

/**
 * git log のフィールド区切り文字。
 * ASCII Unit Separator（0x1F）。通常のテキストに含まれない制御文字。
 * git format では %x1f で埋め込める。
 */
const FIELD_SEPARATOR = "\x1f";
/** git format に埋め込む形式 */
const FIELD_SEPARATOR_FMT = "%x1f";

/**
 * git log のレコード区切り文字。
 * ASCII Record Separator（0x1E）。通常のテキストに含まれない制御文字。
 * git format では %x1e で埋め込める。
 */
const RECORD_SEPARATOR = "\x1e";
/** git format に埋め込む形式 */
const RECORD_SEPARATOR_FMT = "%x1e";

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
 * HEAD 系統とデフォルトブランチ系統のコミット履歴を別々に取得する。
 * renderer 側でマージ・ソートするため、desktop では2つの結果を分けて返す。
 */
export async function getGitLog({
  cwd,
  maxCount,
  firstParentOnly,
}: {
  cwd: string;
  maxCount?: number;
  firstParentOnly?: boolean;
}): Promise<{
  headCommits: GitCommit[];
  defaultBranchCommits: GitCommit[];
  defaultBranch?: string;
}> {
  const count = Math.min(maxCount ?? DEFAULT_MAX_COUNT, DEFAULT_MAX_COUNT);
  // %b（body）は改行を含むため最後に配置。パース時に残り全部を body として扱う
  const format = ["%H", "%P", "%aN", "%at", "%s", "%D", "%b"].join(FIELD_SEPARATOR_FMT);
  const [defaultBranch, currentBranch] = await Promise.all([
    resolveDefaultBranch(cwd),
    resolveCurrentBranch(cwd),
  ]);

  // HEAD 系統の ref を構築（HEAD + current ブランチのリモート ref）
  const headRefs = ["HEAD"];
  if (currentBranch) {
    const remoteRef = await resolveRemoteRef({ cwd, branch: currentBranch });
    if (remoteRef) headRefs.push(remoteRef);
  }

  // デフォルトブランチ系統の ref を構築
  const defaultRefs: string[] = [];
  if (defaultBranch) {
    const hasLocalDefault = await localRefExists({ cwd, branch: defaultBranch });
    if (hasLocalDefault) defaultRefs.push(defaultBranch);
    const remoteRef = await resolveRemoteRef({ cwd, branch: defaultBranch });
    if (remoteRef) defaultRefs.push(remoteRef);
  }

  const baseArgs = [
    "git",
    "log",
    `--format=${RECORD_SEPARATOR_FMT}${format}`,
    "--date-order",
    `--max-count=${count}`,
  ];
  if (firstParentOnly) baseArgs.push("--first-parent");

  // HEAD 系統とデフォルトブランチ系統を並列で取得
  const [headResult, defaultResult] = await Promise.all([
    tryCatch(new Response(Bun.spawn([...baseArgs, ...headRefs, "--"], { cwd }).stdout).text()),
    defaultRefs.length > 0
      ? tryCatch(
          new Response(Bun.spawn([...baseArgs, ...defaultRefs, "--"], { cwd }).stdout).text(),
        )
      : Promise.resolve(undefined),
  ]);

  const headCommits = headResult.ok ? parseGitLog(headResult.value) : [];
  const defaultBranchCommits = defaultResult?.ok ? parseGitLog(defaultResult.value) : [];

  return { headCommits, defaultBranchCommits, defaultBranch };
}

function parseGitLog(output: string): GitCommit[] {
  if (!output) return [];

  const records = output.split(RECORD_SEPARATOR).filter(Boolean);
  const commits: GitCommit[] = [];

  for (const record of records) {
    const fields = record.split(FIELD_SEPARATOR);
    if (fields.length < 7) continue;

    const [hash, parentStr, author, dateStr, message, refStr, ...bodyParts] = fields;
    if (!hash || !author || !dateStr || message === undefined) continue;

    const parents = parentStr ? parentStr.split(" ").filter(Boolean) : [];
    const date = Number.parseInt(dateStr, 10);
    if (Number.isNaN(date)) continue;

    const refs = refStr ? parseRefs(refStr) : [];
    // %b は git が末尾に改行を付与するため除去
    const body = bodyParts.join(FIELD_SEPARATOR).replace(/\n+$/, "");

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author,
      date,
      message,
      body,
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
