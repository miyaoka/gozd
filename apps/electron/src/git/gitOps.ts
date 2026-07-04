// git RPC op。Swift 版 `GitOps+Worktree.swift` / `GitOps+Status.swift` /
// `GitOps+Branch.swift` の対応物。parser は `porcelain.ts` に分離してある。

import { tryCatch } from "@gozd/shared";
import { statSync } from "node:fs";
import { join } from "node:path";
import { runGit, runGitNonInteractive } from "./gitRunner";
import {
  parsePorcelainV2WithBranch,
  parseWorktreePorcelain,
  type StatusFull,
  type WorktreeInfo,
} from "./porcelain";

/** `git worktree list --porcelain` 相当 */
export async function worktreeList(dir: string): Promise<WorktreeInfo[]> {
  return parseWorktreePorcelain(await runGit(["worktree", "list", "--porcelain"], dir));
}

/**
 * status + HEAD + upstream + ahead/behind を 1 セットで取得する。
 * `--untracked-files=all` は untracked ディレクトリ配下も個別列挙させるため必須
 * （外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）
 */
export async function gitStatusFull(dir: string): Promise<StatusFull> {
  const stdout = await runGit(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    dir,
  );
  const parsed = parsePorcelainV2WithBranch(stdout);
  return { ...parsed, latestMtime: latestMtimeOf(dir, Object.keys(parsed.statuses)) };
}

/**
 * `git fetch --all --no-write-fetch-head` を非対話 env で実行する。
 * 失敗は throw する。呼び出し側で「offline / 認証失敗等は静かに飲み込む」判断をする
 */
export async function fetchRemotes(dir: string): Promise<void> {
  await runGitNonInteractive(["fetch", "--all", "--no-write-fetch-head"], dir);
}

/**
 * relPaths を dir 基準で stat し、mtime の最大値 (Unix 秒) を返す。
 * 全 path で stat 失敗 / 入力空のとき 0。削除済みパスは stat 失敗で自然に除外される
 */
function latestMtimeOf(dir: string, relPaths: string[]): number {
  let maxTs = 0;
  for (const rel of relPaths) {
    const stat = tryCatch(() => statSync(join(dir, rel)));
    if (!stat.ok) continue;
    const ts = Math.floor(stat.value.mtimeMs / 1000);
    if (ts > maxTs) maxTs = ts;
  }
  return maxTs;
}
