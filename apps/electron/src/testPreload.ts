// bun test の preload（bunfig.toml [test].preload）。テストプロセスの process.env から
// GIT_* を除去し、テスト対象実装が spawn する git を ambient な git 環境から隔離する。
// 隔離ポリシー（剥がす prefix / config 隔離ペア）の SSOT は testGitFixture.ts。
//
// git hook（lefthook の pre-commit ジョブ等）配下では git が GIT_DIR / GIT_INDEX_FILE を
// 注入し、linked worktree ではどちらも絶対パスになる。GIT_DIR は cwd より優先されるため、
// 継承 env のままの git spawn は fixture でなく実リポジトリを書き換える
// （2026-07-22 の ref / config 汚染事故）。git 自身も別 repo へ子 git を起こす際は
// prepare_other_repo_env（run-command.c）で repo-local env を全消しするのが規範。
//
// この preload が守るのは「process.env を列挙して env を明示構築する」spawn 経路
// （gitRunner の gozdGitEnv 等）と async spawn。Bun の sync spawn（execFileSync）は
// JS レベルの process.env mutation を子に伝えないため（Bun 1.3.14 実測）、fixture の
// git 実行は testGitFixture.ts の runFixtureGit（env 明示指定）を必ず使う。この二層で
// 「テスト対象」「fixture」双方の git spawn が隔離される。

import { GIT_CONFIG_ISOLATION, GIT_ENV_PREFIX } from "./testGitFixture";

for (const key of Object.keys(process.env)) {
  if (key.startsWith(GIT_ENV_PREFIX)) delete process.env[key];
}

Object.assign(process.env, GIT_CONFIG_ISOLATION);
