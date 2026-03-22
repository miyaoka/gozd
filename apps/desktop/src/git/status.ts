import { tryCatch } from "@gozd/shared";
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

export async function getGitStatus(cwd: string): Promise<Record<string, string>> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "status", "--porcelain=v1", "-z"], { cwd }).stdout).text(),
  );
  if (!result.ok) return {};
  const stdout = result.value;
  const statuses: Record<string, string> = {};
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry) {
      i++;
      continue;
    }
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      i++;
      const newPath = parts[i];
      if (newPath !== undefined) {
        statuses[newPath] = status;
      }
    } else {
      statuses[filePath] = status;
    }
    i++;
  }
  return statuses;
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

async function buildDiffArgs(cwd: string, hash: string, compareHash?: string): Promise<string[]> {
  const diffOptions = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"];

  if (compareHash !== undefined) {
    // 範囲選択: 古い方の親を起点に新しい方を終点にする
    const orderResult = await tryCatch(
      Bun.spawn(["git", "merge-base", "--is-ancestor", hash, compareHash], { cwd }).exited,
    );
    const hashIsOlder = orderResult.ok && orderResult.value === 0;
    const older = hashIsOlder ? hash : compareHash;
    const newer = hashIsOlder ? compareHash : hash;

    // 古い方がルートコミットの場合はルート自体を from にする
    if (await isRootCommit(cwd, older)) {
      return ["git", "diff", ...diffOptions, older, newer];
    }
    return ["git", "diff", ...diffOptions, `${older}^`, newer];
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
    const code = status[1] !== " " ? status[1] : status[0];
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
