// git CLI ラッパー。Swift 版 `GitRunner.swift` の対応物。
//
// - `GIT_OPTIONAL_LOCKS=0`: read-only コマンド (`status` 等) が opportunistic に取る
//   `index.lock` を抑止する。gozd はバックグラウンドで `git status` を頻繁に叩くため、
//   これが無いとユーザー foreground の `git commit` / `git add` と lock 競合して
//   ユーザー側が exit 128 で即死する（VS Code / GitHub Desktop も同じ設定）
// - CommandResolver（ログインシェル経由の git 絶対パス解決）は Finder/Dock 起動対応の
//   ステップで移植する。terminal 由来 PATH の dev 起動では `git` が同一バイナリに解決される

import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** git status の出力は repo サイズ依存で大きくなり得るため、node デフォルト (1MB) を広げる */
const GIT_MAX_BUFFER = 128 * 1024 * 1024;

/** git が走ったが non-zero exit した失敗。exit 128 は "not a git repository" の git 規約 */
export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`git exited with ${exitCode}: ${stderr.slice(0, 200)}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface ExecError extends Error {
  code?: number | string;
  stderr?: string;
}

function gozdGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** 認証 prompt を完全に塞ぐ env。背景 fetch が passphrase / username 入力で hang しないため */
function buildNonInteractiveEnv(base: Record<string, string>): Record<string, string> {
  const env = { ...base };
  env.GIT_TERMINAL_PROMPT = "0";
  const existingSsh = (env.GIT_SSH_COMMAND ?? "").trim();
  env.GIT_SSH_COMMAND = `${existingSsh === "" ? "ssh" : existingSsh} -o BatchMode=yes`;
  return env;
}

async function execGit(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const result = await tryCatch(
    execFileAsync("git", args, { cwd, env, maxBuffer: GIT_MAX_BUFFER }),
  );
  if (result.ok) return result.value.stdout;
  const error = result.error as ExecError;
  if (typeof error.code === "number") {
    throw new GitCommandError(error.code, error.stderr ?? "");
  }
  // spawn 失敗（ENOENT 等）は commandFailed と区別してそのまま伝播する
  throw result.error;
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd, gozdGitEnv());
}

export function runGitNonInteractive(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd, buildNonInteractiveEnv(gozdGitEnv()));
}
