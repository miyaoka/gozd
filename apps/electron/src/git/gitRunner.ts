// git CLI ラッパー。Swift 版 `GitRunner.swift` の対応物。
//
// - `GIT_OPTIONAL_LOCKS=0`: read-only コマンド (`status` 等) が opportunistic に取る
//   `index.lock` を抑止する。gozd はバックグラウンドで `git status` を頻繁に叩くため、
//   これが無いとユーザー foreground の `git commit` / `git add` と lock 競合して
//   ユーザー側が exit 128 で即死する（VS Code / GitHub Desktop も同じ設定）
// - CommandResolver（ログインシェル経由の git 絶対パス解決）は Finder/Dock 起動対応の
//   ステップで移植する。terminal 由来 PATH の dev 起動では `git` が同一バイナリに解決される

import { tryCatch } from "@gozd/shared";
import { execFile, spawn } from "node:child_process";
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
  stderr?: string | Buffer;
  stdout?: string | Buffer;
}

function stderrText(error: ExecError): string {
  if (error.stderr === undefined) return "";
  return typeof error.stderr === "string" ? error.stderr : error.stderr.toString("utf8");
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
    throw new GitCommandError(error.code, stderrText(error));
  }
  // spawn 失敗（ENOENT 等）は commandFailed と区別してそのまま伝播する
  throw result.error;
}

/**
 * stdout を raw Buffer で返す runGit。`git show <rev>:<path>` 等の blob 読み取り用。
 * string 経路（default encoding utf8）はバイナリ blob を lossy 変換して NUL byte 判定を
 * 壊すため、binary 判定が要る経路はこちらを使う
 */
export async function runGitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const result = await tryCatch(
    execFileAsync("git", args, {
      cwd,
      env: gozdGitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "buffer",
    }),
  );
  if (result.ok) return result.value.stdout;
  const error = result.error as ExecError;
  if (typeof error.code === "number") {
    throw new GitCommandError(error.code, stderrText(error));
  }
  throw result.error;
}

/**
 * `git diff` 系専用: exit 0（差分なし）/ 1（差分あり）をどちらも成功として stdout を返す。
 * exit > 1 は通常エラー扱い（Swift runGitDiffNoIndex と同契約）
 */
export async function runGitAllowExit1(args: string[], cwd: string): Promise<string> {
  const result = await tryCatch(
    execFileAsync("git", args, { cwd, env: gozdGitEnv(), maxBuffer: GIT_MAX_BUFFER }),
  );
  if (result.ok) return result.value.stdout;
  const error = result.error as ExecError;
  if (error.code === 1 && typeof error.stdout === "string") return error.stdout;
  if (typeof error.code === "number") {
    throw new GitCommandError(error.code, stderrText(error));
  }
  throw result.error;
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd, gozdGitEnv());
}

/**
 * stdin にデータを流して git を実行する。`git check-ignore --stdin` 等の
 * stdin バッチ経路用。
 *
 * `treatNonZeroExitAsSuccess`: check-ignore は「無視パスがあれば exit 0、無ければ exit 1」を
 * 返す仕様のため、exit != 0 でも stderr が空なら成功として stdout を返す opt-in
 * （このフラグは check-ignore 専用。Swift 版 runGitWithStdin と同契約）
 */
export function runGitWithStdin(
  args: string[],
  cwd: string,
  stdin: string,
  { treatNonZeroExitAsSuccess = false } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gozdGitEnv() });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0 || (treatNonZeroExitAsSuccess && stderr === "")) {
        resolve(stdout);
        return;
      }
      reject(new GitCommandError(code ?? -1, stderr));
    });
    // EPIPE (git が stdin を読み切る前に終了) は error event で拾われるが、
    // stdin 側の書き込みエラーはプロセス失敗と独立に起こり得るため個別に握って close に任せる
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export function runGitNonInteractive(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd, buildNonInteractiveEnv(gozdGitEnv()));
}
