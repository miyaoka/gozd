// worktree / branch を変更する書き込み系操作。Swift 版 `WorktreeOps.swift` の対応物。
// 読み取り系（list / log）は gitOps / gitLog、副作用持ち（create / remove）はここ。

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tryCatch } from "@gozd/shared";
import { resolveProjectKey } from "../taskStore";
import { worktreeList } from "./gitOps";
import { runGit } from "./gitRunner";
import type { WorktreeInfo } from "./porcelain";

/**
 * `git worktree add [-B <branch>] [--no-track] <path> [<commit-ish>]` 相当。
 *
 * `worktreeDir` はリーフ名（typically タイムスタンプ）。リポジトリ汚染を避けるため
 * `~/.local/share/gozd/worktrees/<projectKey>/<worktreeDir>` に絶対パスとして配置する。
 * `dir` は main repo / worktree subdir のどれでも可（projectKey 解決で main repo root に揃う）。
 *
 * startPoint があれば -B で新規 or リセットしてブランチ作成、なければ既存ブランチを使う。
 * startPoint が `origin/<ref>` 形式なら remote-tracking ref をローカルに用意するため先行で
 * `git fetch origin <ref>` を実行する（PR picker は GitHub 直問い合わせの head ref を渡すため、
 * ローカル clone が stale な場合に必要）。
 */
export async function createWorktree(params: {
  dir: string;
  worktreeDir: string;
  branch: string;
  startPoint: string;
}): Promise<WorktreeInfo> {
  const { dir, worktreeDir, branch, startPoint } = params;
  const absPath = await ensureWorktreePath(dir, worktreeDir);
  const args = ["worktree", "add"];
  if (startPoint !== "") {
    const originPrefix = "origin/";
    if (startPoint.startsWith(originPrefix)) {
      await runGit(["fetch", "origin", startPoint.slice(originPrefix.length)], dir);
    }
    // -B: ローカルブランチが既存なら startPoint にリセット、未存在なら作成。
    // 他 worktree で checkout 中のブランチは git 側が `fatal: cannot force update ...` を
    // 返すのでそのまま throw して呼び出し側の notify.error に stderr を流す
    args.push("-B", branch, "--no-track", absPath, startPoint);
  } else {
    args.push(absPath, branch);
  }
  await runGit(args, dir);
  const list = await worktreeList(dir);
  const resolved = realpathOrSelf(absPath);
  const entry = list.find((wt) => wt.path === absPath || realpathOrSelf(wt.path) === resolved);
  if (entry === undefined) {
    throw new Error(`worktree created but not found in list: ${absPath}`);
  }
  return entry;
}

/** `git worktree remove [-f] <path>` 相当 */
export async function removeWorktree(dir: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("-f");
  args.push(path);
  await runGit(args, dir);
}

/**
 * `~/.local/share/gozd/worktrees/<projectKey>/<leaf>` の絶対パスを返し、親ディレクトリを作成する。
 * `leaf` は 1 path component のみ許可。`/`, `.`, `..`, 制御文字を含むものは拒否する
 * （base 配下からの逸脱や、ファイル API への橋渡しでの予期しない扱いを防ぐ）
 */
async function ensureWorktreePath(projectDir: string, leaf: string): Promise<string> {
  const invalid =
    leaf === "" ||
    leaf.includes("/") ||
    leaf === "." ||
    leaf === ".." ||
    [...leaf].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  if (invalid) {
    throw new Error(`invalid worktree leaf name: ${leaf}`);
  }
  const projectKey = await resolveProjectKey(projectDir);
  const base = join(homedir(), ".local", "share", "gozd", "worktrees", projectKey);
  mkdirSync(base, { recursive: true });
  return join(base, leaf);
}

function realpathOrSelf(path: string): string {
  const result = tryCatch(() => realpathSync(path));
  return result.ok ? result.value : path;
}
