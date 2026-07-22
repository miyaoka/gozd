// branch / remote 系の解決 helper。Swift 版 `GitOps+Branch.swift` の対応物。
//
// エラー方針（Swift 版から継承）: 各関数は commandFailed（GitCommandError）を握り潰さず
// throw し、空文字への fallback 判断は呼び出し側（gitLog.log / resolveStartPoint）に委ねる。
// spawn 失敗（ENOENT 等の launchFailed 相当）も rethrow して上位の notify.error 経路に通す。

import { tryCatch } from "@gozd/shared";
import { GitCommandError, runGit } from "./gitRunner";

/**
 * HEAD が指す branch 名を返す（例: `main` / `feature/foo`）。
 * porcelain v2 の `# branch.head` と同一 semantics を `git symbolic-ref --short HEAD` で取得し、
 * SSOT を `gitStatusChange` push payload と一致させる。
 * - unborn branch（commit 無し）: branch 名を exit 0 で返す
 * - detached HEAD: exit 128 で GitCommandError を throw する
 */
export async function branchHeadName(dir: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], dir)).trim();
}

/** HEAD の upstream ref 名を返す（例: `origin/foo`）。
 * upstream 未設定 / detached HEAD では GitCommandError を throw する */
export async function upstreamRefName(dir: string): Promise<string> {
  return (
    await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], dir)
  ).trim();
}

/** `git symbolic-ref --short refs/remotes/origin/HEAD` 相当。`origin/` prefix は剥がして
 * `main` のみ返す（git-graph の RefBadge 用途） */
export async function defaultBranchName(dir: string): Promise<string> {
  const text = (await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).trim();
  if (text.startsWith("origin/")) return text.slice("origin/".length);
  return text;
}

/**
 * HEAD が commit OID を解決できるかを返す。exit 0 なら true（通常 branch / detached HEAD）、
 * exit ≠ 0 なら false（unborn branch 等）。
 *
 * `--quiet` は必須: unborn HEAD で「exit ≠ 0 + stderr 空」を保証し、silent false の正常パスと
 * stderr 非空の異常系（観察ログを残して false）を区別する分岐契約を成立させる
 */
export async function headOidExists(dir: string): Promise<boolean> {
  const result = await tryCatch(runGit(["rev-parse", "--verify", "--quiet", "HEAD"], dir));
  if (result.ok) return true;
  if (result.error instanceof GitCommandError && result.error.stderr === "") {
    // unborn HEAD: 正常系として silent に倒す
    return false;
  }
  console.error(`[GitOps] headOidExists: fallback to false (${result.error}) dir=${dir}`);
  return false;
}

/**
 * ローカル / リモートの全ブランチ ref 名を返す（例: `refs/heads/main` /
 * `refs/remotes/origin/foo`）。git graph の全ブランチ表示で `git log --stdin` の
 * 始点に投入する。full refname で返すため log の始点として曖昧さがない。
 *
 * `refs/remotes/origin/HEAD`（symref）も含まれるが、指す先が origin/<default> と同一で
 * git log の OID dedup に吸収されるため無害。tags は含めない（branch graph の対象外）。
 */
export async function allBranchRefs(dir: string): Promise<string[]> {
  const stdout = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
    dir,
  );
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * worktree 作成の起点として使う ref を返す。`git worktree add -b <new> <abs> <ref>` の
 * `<ref>` にそのまま渡せる文字列（`origin/main` / `main` 等）が caller の期待値。
 *
 * (1) origin/HEAD 経由で remote default branch（`origin/main` 等、prefix を剥がさない）
 * (2) 失敗時は current branch に fallback（remote 未設定 / push 前 repo）
 * (3) どちらも引けない（detached HEAD / unborn branch）は GitCommandError が throw され、
 *     caller（handleGitDefaultBranch）が空文字に倒す
 */
export async function resolveStartPoint(dir: string): Promise<string> {
  const remote = await tryCatch(
    runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir),
  );
  if (remote.ok) {
    const text = remote.value.trim();
    if (text !== "") return text;
  } else if (!(remote.error instanceof GitCommandError)) {
    // origin/HEAD 未設定は commandFailed で来るのでそれだけ受け流して HEAD fallback に進む。
    // spawn 失敗等はドメイン失敗ではないため rethrow する
    throw remote.error;
  }
  return (await runGit(["symbolic-ref", "--short", "HEAD"], dir)).trim();
}
