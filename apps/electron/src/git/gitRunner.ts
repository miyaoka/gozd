// git CLI ラッパー。Swift 版 `GitRunner.swift` の対応物。
//
// - `GIT_OPTIONAL_LOCKS=0`: read-only コマンド (`status` 等) が opportunistic に取る
//   `index.lock` を抑止する。gozd はバックグラウンドで `git status` を頻繁に叩くため、
//   これが無いとユーザー foreground の `git commit` / `git add` と lock 競合して
//   ユーザー側が exit 128 で即死する（VS Code / GitHub Desktop も同じ設定）
// - `git` の絶対パスは commandResolver（ユーザーログインシェル経由の `command -v`）で解決する。
//   Finder/Dock 起動の `.app` は launchd の最小 PATH しか継承せず、素の `execFile("git")` だと
//   Apple 版 `/usr/bin/git` に倒れて Keychain ACL（バイナリ署名単位）の認証ダイアログが再発する。
//   Apple stub への暗黙 fallback はしない（設計理由は commandResolver.ts 冒頭コメント参照）

import { tryCatch } from "@gozd/shared";
import { execFile, spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { withResolvedCommand } from "../commandResolver";

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

function gozdGitEnv(gitPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // packaged Finder 起動の最小 PATH では、git が PATH 探索する兄弟ツール
  // （git-lfs の smudge/clean filter、osxkeychain 以外の credential helper 等）が
  // 見つからない。解決済み git の dir を PATH 先頭に足し、同居ツールを掴めるようにする
  // （Homebrew なら git-lfs 等は同じ /opt/homebrew/bin に居る）
  const gitDir = dirname(gitPath);
  const currentPath = env.PATH ?? "";
  if (!currentPath.split(delimiter).includes(gitDir)) {
    env.PATH = currentPath === "" ? gitDir : `${gitDir}${delimiter}${currentPath}`;
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

async function execGit(args: string[], cwd: string): Promise<string> {
  return withResolvedCommand("git", async (gitPath) => {
    const result = await tryCatch(
      execFileAsync(gitPath, args, { cwd, env: gozdGitEnv(gitPath), maxBuffer: GIT_MAX_BUFFER }),
    );
    if (result.ok) return result.value.stdout;
    const error = result.error as ExecError;
    if (typeof error.code === "number") {
      throw new GitCommandError(error.code, stderrText(error));
    }
    // spawn 失敗（ENOENT 等）は commandFailed と区別してそのまま伝播する
    // （ENOENT は withResolvedCommand が stale cache として 1 回だけ再解決 + retry する）
    throw result.error;
  });
}

/**
 * stdout を raw Buffer で返す runGit。`git show <rev>:<path>` 等の blob 読み取り用。
 * string 経路（default encoding utf8）はバイナリ blob を lossy 変換して NUL byte 判定を
 * 壊すため、binary 判定が要る経路はこちらを使う
 */
export async function runGitBuffer(args: string[], cwd: string): Promise<Buffer> {
  return withResolvedCommand("git", async (gitPath) => {
    const result = await tryCatch(
      execFileAsync(gitPath, args, {
        cwd,
        env: gozdGitEnv(gitPath),
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
  });
}

/**
 * `git diff` 系専用: exit 0（差分なし）/ 1（差分あり）をどちらも成功として stdout を返す。
 * exit > 1 は通常エラー扱い（Swift runGitDiffNoIndex と同契約）
 */
export async function runGitAllowExit1(args: string[], cwd: string): Promise<string> {
  return withResolvedCommand("git", async (gitPath) => {
    const result = await tryCatch(
      execFileAsync(gitPath, args, { cwd, env: gozdGitEnv(gitPath), maxBuffer: GIT_MAX_BUFFER }),
    );
    if (result.ok) return result.value.stdout;
    const error = result.error as ExecError;
    if (error.code === 1 && typeof error.stdout === "string") return error.stdout;
    if (typeof error.code === "number") {
      throw new GitCommandError(error.code, stderrText(error));
    }
    throw result.error;
  });
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd);
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
  return withResolvedCommand("git", (gitPath) =>
    runGitWithStdinOnce(gitPath, args, cwd, stdin, { treatNonZeroExitAsSuccess }),
  );
}

function runGitWithStdinOnce(
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string,
  { treatNonZeroExitAsSuccess = false } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, env: gozdGitEnv(gitPath) });
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

/**
 * ネットワーク系 git（fetch 等）の観察ログつき実行。keychain ダイアログの発火源特定用:
 *
 * - 開始 / 完了を対で `[gitRunner]` に出す。keychain ダイアログ表示中は credential helper が
 *   ブロックするため、「start が出て done が出ていない invocation」がダイアログの発火源
 * - 実行バイナリの絶対パスと所要時間も残す（keychain ACL はバイナリ単位なので、
 *   どの git が走ったかが原因特定の核心情報）
 * - `GOZD_GIT_TRACE=1` で git 自身の trace（credential helper の実行行
 *   `run_command: ... credential-...`）を有効化し、完了ログに credential 関連行を抽出して残す。
 *   常時 on にしないのは、GIT_TRACE の stderr が GitCommandError の detail
 *   （renderer の失敗トースト）を trace 行で押し流すため
 */
export async function runGitNonInteractive(args: string[], cwd: string): Promise<string> {
  return withResolvedCommand("git", async (gitPath) => {
    const env = buildNonInteractiveEnv(gozdGitEnv(gitPath));
    const traceEnabled = process.env.GOZD_GIT_TRACE === "1";
    if (traceEnabled) env.GIT_TRACE = "1";
    const argsText = args.join(" ");
    const startedAt = Date.now();
    console.error(`[gitRunner] start git=${gitPath} args=[${argsText}] cwd=${cwd}`);
    const result = await tryCatch(
      execFileAsync(gitPath, args, { cwd, env, maxBuffer: GIT_MAX_BUFFER }),
    );
    const elapsedMs = Date.now() - startedAt;
    let credentialSuffix = "";
    if (traceEnabled) {
      const stderr = result.ok ? result.value.stderr : stderrText(result.error as ExecError);
      const credentialLines = stderr
        .split("\n")
        .filter((line) => line.toLowerCase().includes("credential"))
        .join(" | ");
      credentialSuffix = ` credential: ${credentialLines === "" ? "(none)" : credentialLines}`;
    }
    console.error(
      `[gitRunner] done ok=${result.ok} ${elapsedMs}ms git=${gitPath} args=[${argsText}] cwd=${cwd}${credentialSuffix}`,
    );
    if (result.ok) return result.value.stdout;
    const error = result.error as ExecError;
    if (typeof error.code === "number") {
      throw new GitCommandError(error.code, stderrText(error));
    }
    throw result.error;
  });
}
