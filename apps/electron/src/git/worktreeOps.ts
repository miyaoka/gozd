// worktree / branch を変更する書き込み系操作。Swift 版 `WorktreeOps.swift` の対応物。
// 読み取り系（list / log）は gitOps / gitLog、副作用持ち（create / remove）はここ。

import { mkdirSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { generateTimestamp, tryCatch } from "@gozd/shared";
import { resolveContained } from "../fs/pathContainment";
import { gozdWorktreesRoot, resolveMainRepoRoot, resolveProjectKey } from "../taskStore";
import { resolveStartPoint } from "./gitBranch";
import { worktreeList } from "./gitOps";
import { runGit } from "./gitRunner";
import type { WorktreeInfo } from "./porcelain";

/**
 * `git worktree add [-B <branch>] [--no-track] <path> [<commit-ish>]` 相当。
 *
 * `worktreeDir` はリーフ名（typically タイムスタンプ）。リポジトリ汚染を避けるため
 * `~/.local/share/gozd/worktrees/<projectKey>/<worktreeDir>` に絶対パスとして配置する。
 * `dir` は main repo / worktree subdir のどれでも可（projectKey 解決で main repo root に揃う）。
 *
 * startPoint があれば -B で新規 or リセットしてブランチ作成、なければ既存ブランチを使う。
 * startPoint が `origin/<ref>` 形式なら remote-tracking ref をローカルに用意するため先行で
 * `git fetch origin <ref>` を実行する（PR picker は GitHub 直問い合わせの head ref を渡すため、
 * ローカル clone が stale な場合に必要）。
 */
export async function createWorktree(params: {
  dir: string;
  worktreeDir: string;
  branch: string;
  startPoint: string;
  /** メインリポジトリからシンボリックリンクする相対パス一覧（project 設定 worktreeSymlinks） */
  symlinks: string[];
}): Promise<WorktreeInfo> {
  const { dir, worktreeDir, branch, startPoint, symlinks } = params;
  const absPath = await ensureWorktreePath(dir, worktreeDir);
  const args = ["worktree", "add"];
  if (startPoint !== "") {
    const originPrefix = "origin/";
    if (startPoint.startsWith(originPrefix)) {
      await runGit(["fetch", "origin", startPoint.slice(originPrefix.length)], dir);
    }
    // -B: ローカルブランチが既存なら startPoint にリセット、未存在なら作成。
    // 他 worktree で checkout 中のブランチは git 側が `fatal: cannot force update ...` を
    // 返すのでそのまま throw して呼び出し側の notify.error に stderr を流す
    args.push("-B", branch, "--no-track", absPath, startPoint);
  } else {
    args.push(absPath, branch);
  }
  await runGit(args, dir);
  // symlink source は main repo root 基準。dir は subdir / worktree のこともある
  // （createWorktree の dir 契約）ため、worktree 配置と同じく main root に解決してから渡す。
  const mainRepoRoot = await resolveMainRepoRoot(dir);
  createWorktreeSymlinks(mainRepoRoot, absPath, symlinks);
  const list = await worktreeList(dir);
  const resolved = realpathOrSelf(absPath);
  const entry = list.find((wt) => wt.path === absPath || realpathOrSelf(wt.path) === resolved);
  if (entry === undefined) {
    throw new Error(`worktree created but not found in list: ${absPath}`);
  }
  return entry;
}

/**
 * メインリポジトリの各 target を worktree にシンボリックリンクする。
 * `.claude/` や `.env.local` など git 管理外のローカル設定を全 worktree で共有する用途
 * （pnpm v11 の worktree ヘルパーと同じアプローチ）。
 *
 * - source（mainRepo/target）が存在しなければ skip
 * - dest（worktree/target）が既に存在すれば skip（git checkout で取得済みの可能性）
 * - target は project 設定由来の untrusted 入力なので resolveContained で `..` 脱出を無害化する
 * - ネストした target（`.config/foo`）は dest の親ディレクトリを先に作る
 * - mkdir / symlink 失敗は 1 件でも worktree 作成全体を止めないよう握って観察ログに残す
 *   （中間パスが非ディレクトリで mkdirSync が throw する端ケースでも次の target に進む）
 */
export function createWorktreeSymlinks(
  mainRepoDir: string,
  wtPath: string,
  targets: string[],
): void {
  for (const target of targets) {
    const sourcePath = resolveContained(mainRepoDir, target);
    const destPath = resolveContained(wtPath, target);
    if (sourcePath === undefined || destPath === undefined) {
      console.error(`[createWorktreeSymlinks] rejected traversal target=${target}`);
      continue;
    }
    if (!tryCatch(() => lstatSync(sourcePath)).ok) continue;
    if (tryCatch(() => lstatSync(destPath)).ok) continue;
    // mkdir と symlink は 1 つの tryCatch で握る。中間パスが非ディレクトリで mkdirSync が
    // throw しても worktree 作成全体を止めず、当該 target を skip して次へ進める。
    const linked = tryCatch(() => {
      mkdirSync(dirname(destPath), { recursive: true });
      symlinkSync(sourcePath, destPath);
    });
    if (!linked.ok) {
      console.error(
        `[createWorktreeSymlinks] symlink failed target=${target} error=${linked.error}`,
      );
    }
  }
}

/** branch が他 worktree に checkout 済みか。`git worktree add` / `-B` は他 worktree 占有中の
 * branch を拒否するため、この判定で衝突を先に検知して日付ブランチへ倒す。 */
async function isBranchCheckedOut(dir: string, branch: string): Promise<boolean> {
  return (await worktreeList(dir)).some((wt) => wt.branch === branch);
}

/** ローカルに branch が存在するか。`git rev-parse --verify --quiet refs/heads/<branch>` 相当。 */
async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  const result = await tryCatch(
    runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir),
  );
  return result.ok;
}

/** 復活 worktree のブランチと startPoint を決める（createWorktree にそのまま渡す）。
 *
 * cwd（= worktree のパス）は resume の鍵なので leaf 側で固定し、ここでは branch のみ決める。
 * branch 名は resume に影響しないため、意味のある候補（ログ末尾の PR 名）を優先しつつ衝突だけ避ける:
 * - candidate 空 / 他 worktree 占有 → 衝突。日付ブランチを default から新規作成
 * - candidate 既存（未占有）→ その branch に attach（startPoint 空）
 * - candidate 未存在 → default branch から candidate を新規作成 */
export async function resolveReviveBranch(
  dir: string,
  candidate: string,
): Promise<{ branch: string; startPoint: string }> {
  if (candidate === "" || (await isBranchCheckedOut(dir, candidate))) {
    return { branch: generateTimestamp(), startPoint: await resolveStartPoint(dir) };
  }
  if (await localBranchExists(dir, candidate)) {
    return { branch: candidate, startPoint: "" };
  }
  return { branch: candidate, startPoint: await resolveStartPoint(dir) };
}

/** `git worktree prune` 相当。working dir が消えた missing-but-registered な worktree 登録を掃除する。
 * revive は cwd 不在を条件に列挙するため、外部 rm-rf 済みで `git worktree prune` 未実行の path に
 * stale 登録が残っていると `git worktree add` が失敗する。add 前に prune して、gozd の
 * `git worktree remove` 経由の削除だけでなく外部 rm-rf 由来の stale 登録も同一経路で救う。 */
export async function pruneWorktrees(dir: string): Promise<void> {
  await runGit(["worktree", "prune"], dir);
}

/** `git worktree remove [-f] <path>` 相当 */
export async function removeWorktree(dir: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("-f");
  args.push(path);
  await runGit(args, dir);
}

/**
 * `~/.local/share/gozd/worktrees/<projectKey>/<leaf>` の絶対パスを返し、親ディレクトリを作成する。
 * `leaf` は 1 path component のみ許可。`/`, `.`, `..`, 制御文字を含むものは拒否する
 * （base 配下からの逸脱や、ファイル API への橋渡しでの予期しない扱いを防ぐ）
 */
/** C0 制御文字（< 0x20）と DEL（0x7f）を含むか。for-of は code point 単位で走査する */
function hasControlChar(s: string): boolean {
  for (const char of s) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function ensureWorktreePath(projectDir: string, leaf: string): Promise<string> {
  const invalid =
    leaf === "" || leaf.includes("/") || leaf === "." || leaf === ".." || hasControlChar(leaf);
  if (invalid) {
    throw new Error(`invalid worktree leaf name: ${leaf}`);
  }
  const projectKey = await resolveProjectKey(projectDir);
  const base = join(gozdWorktreesRoot(), projectKey);
  mkdirSync(base, { recursive: true });
  return join(base, leaf);
}

function realpathOrSelf(path: string): string {
  const result = tryCatch(() => realpathSync(path));
  return result.ok ? result.value : path;
}
