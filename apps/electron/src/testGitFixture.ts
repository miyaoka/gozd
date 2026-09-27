// テスト fixture 用の git 実行ヘルパーと、git env 隔離ポリシーの SSOT。
// テストコードで素の execFileSync("git", ...) を書かず、必ず runFixtureGit を経由する。
//
// env を明示指定するのは、git hook（lefthook の pre-commit ジョブ等）配下では git が
// GIT_DIR / GIT_INDEX_FILE（linked worktree では絶対パス）を注入し、GIT_DIR が cwd より
// 優先されるため、env 未指定の git spawn が fixture でなく実リポジトリを書き換えるため
// （2026-07-22 の ref / config 汚染事故）。
// preload（testPreload.ts）の process.env 除去で足りないのは、Bun の sync spawn
// （execFileSync）が JS レベルの process.env mutation を子に伝えないため（Bun 1.3.14 実測。
// async spawn と env 明示指定は反映される）。

import { spyOn } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { commandResolver } from "./commandResolver";

/** git spawn から剥がす環境変数の prefix。git が hook に注入する repo-local 変数を包含する */
export const GIT_ENV_PREFIX = "GIT_";

/**
 * ユーザー / システム gitconfig からの隔離（git t/test-lib.sh と同じ規律）。
 * commit.gpgsign / init.defaultBranch 等のユーザー設定をテストに混入させない
 */
export const GIT_CONFIG_ISOLATION = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

function fixtureGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith(GIT_ENV_PREFIX)) continue;
    env[key] = value;
  }
  Object.assign(env, GIT_CONFIG_ISOLATION);
  return env;
}

/**
 * テスト対象の実装が起動する git の絶対パスを、先に解決しておく。実装は初回の解決で観察ログを
 * stderr に出すが、それは git を起動するテストの検証対象ではない。beforeAll で呼び、以降の
 * テストで出る出力は吸わずに見えるままにする
 */
export async function resolveGitBeforeTests(): Promise<void> {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const resolved = await tryCatch(commandResolver.resolve("git"));
  consoleError.mockRestore();
  if (!resolved.ok) throw resolved.error;
}

/** fixture 操作用に git を実行し、trim 済み stdout を返す。stderr はテストの出力に流さず、
 * 失敗したときだけ例外のメッセージに載せる */
export function runFixtureGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: fixtureGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
