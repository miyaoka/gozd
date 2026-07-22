// テスト fixture 用の git 実行ヘルパー。テストコードで素の execFileSync("git", ...) を
// 書かず、必ずこれを経由する。
//
// env を明示指定するのは、git hook（lefthook の pre-commit ジョブ等）配下では git が
// GIT_DIR / GIT_INDEX_FILE（linked worktree では絶対パス）を注入し、GIT_DIR が cwd より
// 優先されるため、env 未指定の git spawn が fixture でなく実リポジトリを書き換えるため
// （2026-07-22 の ref / config 汚染事故）。
// preload（testPreload.ts）の process.env 除去で足りないのは、Bun の sync spawn
// （execFileSync）が JS レベルの process.env mutation を子に伝えないため（Bun 1.3.14 実測。
// async spawn と env 明示指定は反映される）。

import { execFileSync } from "node:child_process";
import { devNull } from "node:os";

function fixtureGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  // ユーザー / システム gitconfig からの隔離（git t/test-lib.sh と同じ規律）。
  // commit.gpgsign / init.defaultBranch 等のユーザー設定をテストに混入させない
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

/** fixture 操作用に git を実行し、trim 済み stdout を返す */
export function runFixtureGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, env: fixtureGitEnv(), encoding: "utf8" }).trim();
}
