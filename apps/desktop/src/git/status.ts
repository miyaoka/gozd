import { tryCatch } from "@gozd/shared";
import { UNCOMMITTED_HASH } from "@gozd/rpc";
import type { GitFileChange, WorktreeChangeCounts } from "@gozd/rpc";

export async function filterIgnored(entries: string[], cwd: string): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "check-ignore", ...entries], { cwd }).stdout).text(),
  );
  if (!result.ok) return new Set();
  const text = result.value;
  return new Set(text.split("\n").filter(Boolean));
}

export interface GitStatusResult {
  statuses: Record<string, string>;
  /** HEAD のフルコミットハッシュ。取得できない場合は空文字列 */
  head: string;
  /** upstream に対する ahead/behind。push/fetch の検知に使用 */
  upstream?: { ahead: number; behind: number };
}

/**
 * git status --porcelain=v2 --branch -z で、ファイル変更と HEAD ハッシュを単一コマンドで取得する。
 * v2 の branch ヘッダー `# branch.oid <hash>` から HEAD を読み取るため、
 * 別途 git rev-parse HEAD を呼ぶ必要がない（スナップショットの一貫性を保証）。
 */
export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const result = await tryCatch(
    new Response(
      Bun.spawn(["git", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
        cwd,
      }).stdout,
    ).text(),
  );
  if (!result.ok) return { statuses: {}, head: "" };
  const stdout = result.value;
  const statuses: Record<string, string> = {};
  let head = "";
  let upstream: { ahead: number; behind: number } | undefined;
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry) {
      i++;
      continue;
    }

    // branch ヘッダー行（# branch.oid <hash>）
    if (entry.startsWith("# branch.oid ")) {
      const oid = entry.slice("# branch.oid ".length);
      if (oid !== "(initial)") {
        head = oid;
      }
      i++;
      continue;
    }
    // branch ahead/behind（# branch.ab +N -M）
    if (entry.startsWith("# branch.ab ")) {
      const abMatch = entry.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (abMatch) {
        upstream = { ahead: Number(abMatch[1]), behind: Number(abMatch[2]) };
      }
      i++;
      continue;
    }
    // その他の branch ヘッダー行はスキップ
    if (entry.startsWith("# ")) {
      i++;
      continue;
    }

    // v2 changed entry: "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>" (8 spaces before path)
    if (entry.startsWith("1 ")) {
      const xy = entry.slice(2, 4);
      const pathStart = nthIndex(entry, " ", 8);
      if (pathStart !== -1) {
        statuses[entry.slice(pathStart + 1)] = xy;
      }
      i++;
      continue;
    }
    // v2 unmerged entry: "u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" (10 spaces before path)
    if (entry.startsWith("u ")) {
      const xy = entry.slice(2, 4);
      const pathStart = nthIndex(entry, " ", 10);
      if (pathStart !== -1) {
        statuses[entry.slice(pathStart + 1)] = xy;
      }
      i++;
      continue;
    }
    // v2 rename/copy: "2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"
    // -z では <path> の後に NUL 区切りで <origPath> が続く
    if (entry.startsWith("2 ")) {
      const xy = entry.slice(2, 4);
      const pathStart = nthIndex(entry, " ", 9);
      if (pathStart !== -1) {
        const newPath = entry.slice(pathStart + 1);
        statuses[newPath] = xy;
      }
      // 次の NUL 区切りエントリは origPath なのでスキップ
      i += 2;
      continue;
    }
    // untracked: "? <path>"
    if (entry.startsWith("? ")) {
      statuses[entry.slice(2)] = "??";
      i++;
      continue;
    }
    // ignored: "! <path>"
    if (entry.startsWith("! ")) {
      i++;
      continue;
    }

    i++;
  }
  return { statuses, head, upstream };
}

/** 文字列中の n 番目の char の位置を返す。見つからなければ -1 */
function nthIndex(str: string, char: string, n: number): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

/**
 * コミットの変更ファイル一覧を取得する。
 * vscode-git-graph と同じアプローチ:
 * - `--find-renames` で rename 検出
 * - `--diff-filter=AMDR` で対象を絞る
 * - ルートコミット（親なし）は `git diff-tree --root` を使用
 *
 * compareHash 未指定: `hash^..hash` で first parent との差分。
 * compareHash 指定: 古い方の親から新しい方までの差分（範囲内の全変更ファイルの和集合）。
 */
export async function getGitCommitFiles(
  cwd: string,
  hash: string,
  compareHash?: string,
): Promise<GitFileChange[]> {
  const args = await buildDiffArgs(cwd, hash, compareHash);
  const result = await tryCatch(new Response(Bun.spawn(args, { cwd }).stdout).text());
  if (!result.ok) return [];
  return parseDiffNameStatus(result.value);
}

/**
 * コミットがルートコミット（親なし）かどうか判定。
 * git rev-parse hash^ がルートコミットでは失敗（exit 128）する。
 * rev-parse に -- を渡すと rev 解決ではなくリテラル出力になるため使わない。
 */
async function isRootCommit(cwd: string, hash: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "rev-parse", `${hash}^`], { cwd, stderr: "ignore" });
  const exitCode = await proc.exited;
  return exitCode !== 0;
}

/** コミット間の from/to リビジョン参照を解決する。
 * gitShowCommitFile ハンドラーが使用する。
 * from = null はルートコミット（親なし）を意味する。
 * to = null は作業ツリーを意味する。 */
export interface CommitDiffRefs {
  from: string | null;
  to: string | null;
}

export async function resolveCommitDiffRefs(
  cwd: string,
  hash: string,
  compareHash?: string,
): Promise<CommitDiffRefs> {
  if (compareHash !== undefined) {
    const commitA = hash === UNCOMMITTED_HASH ? "HEAD" : hash;
    const commitB = compareHash === UNCOMMITTED_HASH ? "HEAD" : compareHash;
    const hasUncommitted = hash === UNCOMMITTED_HASH || compareHash === UNCOMMITTED_HASH;

    const orderResult = await tryCatch(
      Bun.spawn(["git", "merge-base", "--is-ancestor", commitA, commitB], { cwd }).exited,
    );
    const aIsOlder = orderResult.ok && orderResult.value === 0;
    const older = aIsOlder ? commitA : commitB;
    const newer = aIsOlder ? commitB : commitA;

    const from = (await isRootCommit(cwd, older)) ? older : `${older}^`;
    return { from, to: hasUncommitted ? null : newer };
  }

  // 単一コミット: ルートコミットは親が存在しない
  if (await isRootCommit(cwd, hash)) {
    return { from: null, to: hash };
  }
  return { from: `${hash}^`, to: hash };
}

/**
 * UNCOMMITTED_HASH が含まれる場合は working tree との diff にする。
 * git diff <from> (to なし) = from から working tree への差分。
 */
async function buildDiffArgs(cwd: string, hash: string, compareHash?: string): Promise<string[]> {
  const diffOptions = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"];
  const hasUncommitted = hash === UNCOMMITTED_HASH || compareHash === UNCOMMITTED_HASH;

  if (compareHash !== undefined) {
    // 範囲選択
    const commitA = hash === UNCOMMITTED_HASH ? "HEAD" : hash;
    const commitB = compareHash === UNCOMMITTED_HASH ? "HEAD" : compareHash;

    // 古い方の親を起点にする
    const orderResult = await tryCatch(
      Bun.spawn(["git", "merge-base", "--is-ancestor", commitA, commitB], { cwd }).exited,
    );
    const aIsOlder = orderResult.ok && orderResult.value === 0;
    const older = aIsOlder ? commitA : commitB;
    const newer = aIsOlder ? commitB : commitA;

    const from = (await isRootCommit(cwd, older)) ? older : `${older}^`;

    // 片方が UNCOMMITTED の場合は to を省略して working tree diff
    if (hasUncommitted) {
      return ["git", "diff", ...diffOptions, from];
    }
    return ["git", "diff", ...diffOptions, from, newer];
  }

  // 単一コミット: ルートコミットは diff-tree --root を使う
  if (await isRootCommit(cwd, hash)) {
    return ["git", "diff-tree", "--root", "--no-commit-id", "-r", ...diffOptions, hash];
  }
  return ["git", "diff", ...diffOptions, `${hash}^`, hash];
}

function parseDiffNameStatus(stdout: string): GitFileChange[] {
  const changes: GitFileChange[] = [];
  const parts = stdout.split("\0");
  let i = 0;
  while (i + 1 < parts.length) {
    const status = parts[i];
    if (!status) {
      i++;
      continue;
    }
    const type = status[0] as GitFileChange["type"];
    if (type === "R") {
      const oldFilePath = parts[i + 1];
      const newFilePath = parts[i + 2];
      if (oldFilePath && newFilePath) {
        changes.push({ oldFilePath, newFilePath, type });
      }
      i += 3;
    } else {
      const filePath = parts[i + 1];
      if (filePath) {
        changes.push({ oldFilePath: filePath, newFilePath: filePath, type });
      }
      i += 2;
    }
  }
  return changes;
}

/** XY コードで「未変更」を表す文字か判定する（v1: " ", v2: "."） */
function isUnchanged(char: string | undefined): boolean {
  return char === " " || char === "." || char === undefined;
}

/** git status の2文字コードから変更種別ごとのファイル数を算出 */
export function countChanges(statuses: Record<string, string>): WorktreeChangeCounts {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  for (const status of Object.values(statuses)) {
    if (status === "??") {
      untracked++;
      continue;
    }
    // worktree 側 (Y) を優先、なければ index 側 (X) を使う
    const code = isUnchanged(status[1]) ? status[0] : status[1];
    switch (code) {
      case "A":
        added++;
        break;
      case "D":
        deleted++;
        break;
      default:
        // M, R, C, T, U 等はすべて modified 扱い
        modified++;
        break;
    }
  }

  return { modified, added, deleted, untracked };
}
