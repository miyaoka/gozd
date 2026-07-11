// worktree 内の全ファイル列挙。file picker（Go to File）の列挙 SSOT。
//
// `rg --files` ではなく git を使う: gozd の worktree は常に git repo（renderer 側の
// precondition `isGitRepo` でガード）で、外部バイナリへの依存を増やさず gitignore の
// 解釈も git 自身に委ねられる。

import { runGit } from "./gitRunner";

/** `-z`（NUL 区切り）出力をパス配列に分解する。末尾 NUL 由来の空要素は除外する */
function splitNul(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

/**
 * primary（`--cached --others --exclude-standard`）から deleted（`--deleted`）を差し引く
 * 純粋関数。`--cached` は index ベースの列挙のため、working tree から削除済みで未 stage の
 * ファイルも含んでしまう。picker は「ディスクに実在するファイル」だけを提示する契約なので
 * ここで除外する。
 */
export function subtractDeleted(primaryOutput: string, deletedOutput: string): string[] {
  const deleted = new Set(splitNul(deletedOutput));
  return splitNul(primaryOutput).filter((path) => !deleted.has(path));
}

/**
 * worktree 内の全ファイル（tracked + untracked、gitignore 除外）の相対パスを返す。
 * 出力順は git ls-files の既定順（cached がソート済みで先、others が後）をそのまま保つ。
 *
 * `--deduplicate`（git 2.31+）は必須: merge / rebase のコンフリクト中、`--cached` は
 * unmerged パスを stage 1/2/3 のぶん重複出力する。gozd はコンフリクト解決が日常の
 * worktree 並列ツールなので、重複を畳まないと picker に同一ファイルが 3 行並び
 * Vue の `:key` 一意性契約も壊れる。
 */
export async function lsFiles(dir: string): Promise<string[]> {
  const [primary, deleted] = await Promise.all([
    runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], dir),
    runGit(["ls-files", "-z", "--deleted"], dir),
  ]);
  return subtractDeleted(primary, deleted);
}
