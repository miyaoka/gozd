// 外部 CLI（git / gh 等）の絶対パスをユーザーログインシェル経由で解決してキャッシュする。
// Swift 版 `ProcessExec.swift` の `CommandResolver` の対応物。
//
// **現プロセス PATH を解決に使わない理由**: Finder/Dock 起動の `.app` は launchd の最小 PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`) しか継承しない。`/usr/bin/git` は Xcode/CLT の Apple 版で、
// ターミナルの Homebrew / mise 版とは別バイナリ。macOS の Keychain ACL は「項目 × バイナリ署名」
// 単位のため、別バイナリの git-credential-osxkeychain が keychain にアクセスすると認証ダイアログが
// 再発する（ターミナルで作った credential が `.app` から見えない）。ログインシェル経由の
// `command -v` なら「ユーザーがターミナルで叩く CLI」と同一バイナリに解決され、この非対称が
// 原理的に発生しない。
//
// - シェルは getpwuid 由来（`os.userInfo().shell`）を使う。`$SHELL` は起動元が設定していれば
//   の値で、Finder 起動の GUI アプリでは信頼できない（fallback: `$SHELL` → `/bin/zsh`）
// - `-i -l` 両方付ける: mise / asdf 等は `.zshrc`（interactive 側）で activate されるケースが
//   多く、`-l` 単独では読まない。VSCode の shell environment resolver と同じ判断
// - `detached: true`（libuv が `setsid()` を呼ぶ = Swift 版 `POSIX_SPAWN_SETSID` 相当）:
//   `.app` プロセスは controlling tty を持たないため、子シェルの `-i` job control 初期化
//   （tcsetpgrp 系）が blocking syscall で永久 hang する。新 session leader に切り離すと
//   self-consistent な状態で初期化されて hang しない
// - **fallback を持たない**: 解決失敗を silent に `/usr/bin/<tool>` へ倒すと keychain 非対称が
//   silent に再発する。エラーとして表面化させ呼び出し側に通知する。CLT only ユーザーは
//   ログインシェル経由でも `/usr/bin/git` が返るため fallback 無しでも救われる
// - rc ファイルが stdout に流す余計な文字列に備えて marker で囲んで抽出する

import { tryCatch } from "@gozd/shared";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { sanitizeParentEnv } from "./gozdEnv";

// 重い .zshrc（mise activate + starship init + brew shellenv + 補完初期化）でも通常 1〜2 秒。
// cold cache や I/O 待ちを加味して 5 倍のマージン。これを超える rc 構成は実用上 hang と同義で、
// SIGKILL してエラー表示した方が原因特定に向く（VSCode の shellEnvironmentResolutionTimeout も
// default 10 秒）。「症状を覆い隠す silent fallback」ではなく「症状を error として表面化させる
// 強制中断」
const RESOLVE_TIMEOUT_MS = 10_000;

/** 失敗時に stderr 末尾を error message に残す上限。rc の警告 / hang 直前の出力を事後分析する */
const STDERR_TAIL_BYTES = 4096;

/** shell spawn 失敗 / hang / timeout / marker 抽出失敗。Swift 版 `GitError.launchFailed` 相当 */
export class CommandResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandResolveError";
  }
}

/** `command -v` が空 = CLI 未インストール。Swift 版 `GitError.commandNotFound` 相当 */
class CommandNotFoundError extends Error {
  constructor(commandName: string) {
    super(`'${commandName}' not found via login shell. Is it installed?`);
    this.name = "CommandNotFoundError";
  }
}

// shell 注入境界: name を shell script 文字列内に補間するため ASCII 英数とハイフン /
// アンダースコアに限定する。コード内リテラル経路では問題ないが、API 表面の境界をここで固める
const VALID_COMMAND_NAME = /^[A-Za-z0-9_-]+$/;

/** `getpwuid(getuid())->pw_shell` でユーザーのログインシェルを取得する。
 * chsh 直後などで `$SHELL` が stale でも passwd エントリが SSOT。
 * 絶対パスのみ採用する: Bun の `os.userInfo().shell` は passwd を引かず "unknown" を
 * 返すことがある（bun test 環境）。非絶対パスは $SHELL → /bin/zsh に倒す */
function userLoginShell(): string {
  const info = tryCatch(() => userInfo());
  if (info.ok) {
    const shell = info.value.shell;
    if (shell !== null && shell.startsWith("/")) return shell;
  }
  const envShell = process.env.SHELL;
  if (envShell !== undefined && envShell.startsWith("/")) return envShell;
  return "/bin/zsh";
}

/** 絶対パスかつ実行可能な通常ファイルの場合のみパスを返す。
 * execute bit の立った directory を弾くため isFile も検証する */
function validateExecutablePath(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const stat = tryCatch(() => statSync(path));
  if (!stat.ok || !stat.value.isFile()) return undefined;
  const access = tryCatch(() => accessSync(path, constants.X_OK));
  if (!access.ok) return undefined;
  return path;
}

/** marker 間の本文を返す。marker が揃っていなければ undefined */
function markerBody(text: string, begin: string, end: string): string | undefined {
  const beginIndex = text.indexOf(begin);
  if (beginIndex === -1) return undefined;
  const afterBegin = beginIndex + begin.length;
  const endIndex = text.indexOf(end, afterBegin);
  if (endIndex === -1) return undefined;
  return text.slice(afterBegin, endIndex);
}

/** marker 本文から「絶対パスかつ実行可能」な行を抽出する。`command -v` は通常 1 行を返すが、
 * shell によっては alias / function 定義を返すことがあるため行単位で二重検証する */
function extractExecutablePath(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const validated = validateExecutablePath(line.trim());
    if (validated !== undefined) return validated;
  }
  return undefined;
}

function stderrTail(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").slice(-STDERR_TAIL_BYTES);
}

/** `<shell> -i -l -c 'command -v <name>'` を新 session で起動して絶対パスを得る。
 * 戻り値 undefined = `command -v` が空（コマンド未インストール）。
 * spawn 失敗 / hang / 非 0 exit / marker 抽出失敗は CommandResolveError で reject する */
function lookupViaLoginShell(name: string, shell: string, timeoutMs: number): Promise<string | undefined> {
  const token = randomUUID();
  const begin = `GOZD_BEGIN_${token}`;
  const end = `GOZD_END_${token}`;
  const script = `printf '%s\\n' ${begin}; command -v ${name}; printf '%s\\n' ${end}`;

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-i", "-l", "-c", script], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizeParentEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const settle = (result: { ok: true; value: string | undefined } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // detached spawn の子は process group leader。rc が起動した子孫プロセスが pipe を
      // 掴んだままだと close event が来ないため、group ごと SIGKILL する
      const pid = child.pid;
      if (pid === undefined) return;
      const killed = tryCatch(() => process.kill(-pid, "SIGKILL"));
      if (!killed.ok) child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      settle({
        ok: false,
        error: new CommandResolveError(`CLI resolver: spawn '${shell}' failed: ${error.message}`),
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        settle({
          ok: false,
          error: new CommandResolveError(
            `CLI resolver: '${name}' via '${shell}' timed out (${timeoutMs}ms) and was SIGKILL'd — ` +
              `shell rc may be hanging. stderr tail: ${stderrTail(stderrChunks)}`,
          ),
        });
        return;
      }
      if (code !== 0) {
        const reason = code !== null ? `shell exited with code ${code}` : `shell killed by signal ${signal}`;
        settle({
          ok: false,
          error: new CommandResolveError(
            `CLI resolver: '${name}' via '${shell}' ${reason}. stderr tail: ${stderrTail(stderrChunks)}`,
          ),
        });
        return;
      }

      const text = Buffer.concat(stdoutChunks).toString("utf8");
      const body = markerBody(text, begin, end);
      if (body === undefined) {
        settle({
          ok: false,
          error: new CommandResolveError(
            `CLI resolver: '${name}' via '${shell}' produced no markers. ` +
              "Shell may not parse `-i -l -c <cmd>`.",
          ),
        });
        return;
      }
      if (body.trim() === "") {
        // `command -v` が空 = コマンド未インストール
        settle({ ok: true, value: undefined });
        return;
      }
      const path = extractExecutablePath(body);
      if (path !== undefined) {
        settle({ ok: true, value: path });
        return;
      }
      // exit 0 + marker は埋まっているが絶対 executable パスではない（alias / function を
      // 返した、shell が non-POSIX 等）
      settle({
        ok: false,
        error: new CommandResolveError(
          `CLI resolver: '${name}' via '${shell}' returned non-executable or non-POSIX output. ` +
            "Shell may not parse `command -v`, or the command is an alias/function.",
        ),
      });
    });
  });
}

interface CommandResolverOptions {
  /** テスト用の shell オーバーライド。未指定なら本番経路（userLoginShell()） */
  shellOverride?: string;
  /** テスト用の timeout オーバーライド */
  timeoutMs?: number;
}

export interface CommandResolver {
  /** 指定 name の絶対パスを返す。`command -v` が空（未インストール）なら undefined。
   * shell spawn 失敗 / hang / 起動エラーは CommandResolveError を throw する。
   * 結果はキャッシュされる（positive / negative どちらも）。spawn 失敗はキャッシュしない */
  resolve(name: string): Promise<string | undefined>;
  /** キャッシュ（positive / negative 両方）を無効化する。呼び出し元は
   * `withResolvedCommand` の実行時 ENOENT 経路（positive cache stale = mise / asdf upgrade で
   * versioned path が消えた等）のみ。negative cache（未インストール判定）を自動で
   * 無効化する経路は無く、後からインストールされた CLI の認識にはアプリ再起動が必要 */
  invalidate(name: string): void;
}

export function createCommandResolver({
  shellOverride,
  timeoutMs = RESOLVE_TIMEOUT_MS,
}: CommandResolverOptions = {}): CommandResolver {
  const cache = new Map<string, string>();
  const negativeCache = new Set<string>();
  const inflight = new Map<string, Promise<string | undefined>>();

  async function resolve(name: string): Promise<string | undefined> {
    if (!VALID_COMMAND_NAME.test(name)) {
      throw new CommandResolveError(`CLI resolver: invalid command name '${name}' (must match [A-Za-z0-9_-]+)`);
    }
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    if (negativeCache.has(name)) return undefined;
    const existing = inflight.get(name);
    if (existing !== undefined) return existing;

    const shell = shellOverride ?? userLoginShell();
    const task = lookupViaLoginShell(name, shell, timeoutMs);
    inflight.set(name, task);
    const result = await tryCatch(task);
    inflight.delete(name);
    if (!result.ok) {
      // 失敗時にユーザーには launchFailed 相当としか見えないため、サブ原因を stderr に残す
      console.error(`[commandResolver] resolve failed name=${name} shell=${shell}: ${result.error.message}`);
      throw result.error;
    }
    if (result.value === undefined) {
      negativeCache.add(name);
    } else {
      cache.set(name, result.value);
    }
    // 「どの CLI に解決されたか」は keychain ACL（バイナリ単位）の一致を左右する。
    // dev / packaged / spike すべての実行で事後追跡できるよう、解決のたび stderr に残す
    console.error(
      `[commandResolver] resolved ${name} -> ${result.value ?? "(not installed)"} shell=${shell}`,
    );
    return result.value;
  }

  return {
    resolve,
    invalidate(name: string) {
      cache.delete(name);
      negativeCache.delete(name);
    },
  };
}

/** 本番共有インスタンス */
export const commandResolver = createCommandResolver();

function isEnoent(error: Error): boolean {
  return (error as Error & { code?: unknown }).code === "ENOENT";
}

/**
 * name を絶対パスに解決して run を実行する共通経路。
 *
 * - 未インストール（resolve が undefined）→ CommandNotFoundError を throw（retry 不要、即上位へ）
 * - run が ENOENT で失敗 → キャッシュが stale（mise / asdf upgrade で versioned path が消えた等）
 *   の可能性があるため、1 回だけ invalidate + 再解決して retry する
 */
export async function withResolvedCommand<T>(
  name: string,
  run: (commandPath: string) => Promise<T>,
): Promise<T> {
  const first = await tryCatch(run(await resolveRequired(name)));
  if (first.ok) return first.value;
  if (!isEnoent(first.error)) throw first.error;
  console.error(`[commandResolver] cached path for '${name}' hit ENOENT, invalidating and re-resolving`);
  commandResolver.invalidate(name);
  return run(await resolveRequired(name));
}

async function resolveRequired(name: string): Promise<string> {
  const path = await commandResolver.resolve(name);
  if (path === undefined) throw new CommandNotFoundError(name);
  return path;
}
