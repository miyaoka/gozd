/**
 * macOS で .app バンドルから起動した場合、Launch Services は最小限の環境変数しか渡さない。
 * ユーザーのログインシェルから環境変数を取得し、TERM, PATH, LANG 等を補完する。
 *
 * sindresorhus/shell-env の delimiter 方式を参考に、env -0（NUL 区切り）で実装している。
 * @see https://github.com/sindresorhus/shell-env
 */

import { tryCatch } from "@gozd/shared";

type EnvMap = Record<string, string>;

const DELIMITER = "_GOZD_SHELL_ENV_DELIMITER_";
const RESOLVE_TIMEOUT_MS = 5000;

/** Launch Services 経由の起動かどうかを推定する */
function needsShellEnvResolution(): boolean {
  if (process.platform !== "darwin") return false;

  const currentPath = process.env.PATH ?? "";
  // Launch Services のデフォルト PATH は /usr/bin:/bin:/usr/sbin:/sbin のみ
  return currentPath === "/usr/bin:/bin:/usr/sbin:/sbin" || !process.env.SHELL;
}

/** NUL 区切りの env 出力をパースする */
function parseNulEnv(raw: string): EnvMap {
  const env: EnvMap = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const idx = entry.indexOf("=");
    if (idx === -1) continue;
    env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return env;
}

/** ログインシェルから環境変数を取得する */
async function resolveShellEnv(shell: string): Promise<EnvMap | undefined> {
  // Bun.spawn はシェルが存在しない場合に同期例外（ENOENT）を投げる
  const spawnResult = tryCatch(() =>
    Bun.spawn(
      [
        shell,
        "-ilc",
        // env -0 で NUL 区切り出力。delimiter で囲んでシェル startup のノイズを除去する
        `echo -n "${DELIMITER}"; command env -0; echo -n "${DELIMITER}"; exit`,
      ],
      {
        env: {
          ...(process.env as EnvMap),
          // Oh My Zsh の自動更新を無効化（ブロック防止）
          DISABLE_AUTO_UPDATE: "true",
          ZSH_TMUX_AUTOSTARTED: "true",
          ZSH_TMUX_AUTOSTART: "false",
        },
      },
    ),
  );

  if (!spawnResult.ok) {
    console.error(`[gozd] shell spawn failed (${shell}): ${spawnResult.error}`);
    return undefined;
  }

  const proc = spawnResult.value;

  const result = await tryCatch(
    Promise.race([
      new Response(proc.stdout).text(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error("shell env resolve timeout"));
        }, RESOLVE_TIMEOUT_MS);
      }),
    ]),
  );

  if (!result.ok) {
    console.error(`[gozd] shell env resolve failed (${shell}): ${result.error}`);
    return undefined;
  }

  const delimited = result.value.split(DELIMITER)[1];
  if (!delimited) return undefined;

  return parseNulEnv(delimited);
}

const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash"];

/**
 * アプリ起動時に一度だけ呼び出し、結果をキャッシュして使う。
 * ターミナルから起動した場合（環境変数が揃っている場合）は process.env をそのまま返す。
 */
export async function getShellEnv(): Promise<EnvMap> {
  if (!needsShellEnvResolution()) {
    return process.env as EnvMap;
  }

  const defaultShell = process.env.SHELL ?? "/bin/zsh";
  const shells = [defaultShell, ...FALLBACK_SHELLS.filter((s) => s !== defaultShell)];

  for (const shell of shells) {
    const env = await resolveShellEnv(shell);
    if (env) {
      console.log(`[gozd] shell env resolved via ${shell}`);
      return env;
    }
  }

  console.warn("[gozd] shell env resolve failed, using process.env");
  return process.env as EnvMap;
}
