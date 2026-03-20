import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { tryCatch } from "@orkis/shared";
import type { OpenTargetSelection } from "@orkis/rpc";

/** remote URL から owner/repo を抽出するパターン（HTTPS / SSH / ssh:// 対応、ローカルパスは除外） */
const REMOTE_OWNER_REPO_RE =
  /^(?:(?:https?|ssh):\/\/[^/]+\/|[^@]+@[^:]+:)([^/:]+\/[^/]+?)(?:\.git)?$/;

/** remote URL から owner/repo 形式の名前を抽出する。マッチしなければ undefined */
export function parseOwnerRepo(url: string): string | undefined {
  const match = url.match(REMOTE_OWNER_REPO_RE);
  return match?.[1];
}

/**
 * dir からプロジェクトディレクトリを同期的に解決する。
 * git リポジトリの場合: --git-common-dir で共通 .git ディレクトリを取得し、その親をルートとする。
 * worktree 内で実行しても main worktree のルートが返る。
 * git 管理外の場合: dir をそのままプロジェクトディレクトリとする。
 */
export function resolveProjectDir(dir: string): string {
  const result = tryCatch(() =>
    Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  if (!result.ok) return dir;
  if (result.value.exitCode !== 0) return dir;
  const output = result.value.stdout.toString().trim();
  if (!output) return dir;
  // main worktree では相対パス ".git" が返るため resolve で絶対パス化
  const gitCommonDir = path.resolve(dir, output);
  return path.dirname(gitCommonDir);
}

/**
 * dir から worktree ルートを同期的に解決する（--show-toplevel）。
 * main worktree ではそのルート、linked worktree ではその worktree のルートが返る。
 * git 管理外の場合: dir をそのまま返す。
 */
export function resolveWorktreeRoot(dir: string): string {
  const result = tryCatch(() =>
    Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  if (!result.ok) return dir;
  if (result.value.exitCode !== 0) return dir;
  const output = result.value.stdout.toString().trim();
  if (!output) return dir;
  return output;
}

/** resolveOpenTarget の戻り値 */
export interface ResolvedOpenTarget {
  projectDir: string;
  activeDir: string;
  selection?: OpenTargetSelection;
}

/**
 * 絶対パスから最初に存在する祖先ディレクトリを探す。
 * 非存在パスでも dirname を遡ることで git コマンドを実行可能なディレクトリを見つける。
 */
function findExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    // ルートに到達（これ以上遡れない）
    if (parent === current) return current;
    current = parent;
  }
  // ファイルの場合は親ディレクトリを返す
  if (!statSync(current).isDirectory()) {
    return path.dirname(current);
  }
  return current;
}

/**
 * CLI から受け取った絶対パスを、プロジェクト・worktree・選択対象に解決する。
 * - 既存ファイル → そのファイルの worktree をアクティブにし、ファイルを選択
 * - 既存ディレクトリ = worktree root → その worktree をアクティブに
 * - 既存ディレクトリ = サブディレクトリ → 属する worktree をアクティブにし、ディレクトリを選択
 * - 非存在 → 存在する祖先ディレクトリから解決し、ファイルとして扱う
 */
export function resolveOpenTarget(targetPath: string): ResolvedOpenTarget {
  if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
    const activeDir = resolveWorktreeRoot(targetPath);
    const projectDir = resolveProjectDir(targetPath);
    // worktree root 自体ならサブディレクトリ選択なし
    if (activeDir === path.resolve(targetPath)) {
      return { projectDir, activeDir };
    }
    // サブディレクトリ → ディレクトリを選択対象にする
    return {
      projectDir,
      activeDir,
      selection: { kind: "directory", relPath: path.relative(activeDir, targetPath) },
    };
  }

  // ファイル（存在する場合も非存在の場合も同じ扱い）
  // 非存在パスは祖先を遡って git コマンドを実行可能なディレクトリを見つける
  const dir = findExistingAncestor(targetPath);
  const activeDir = resolveWorktreeRoot(dir);
  const projectDir = resolveProjectDir(dir);
  return {
    projectDir,
    activeDir,
    selection: { kind: "file", relPath: path.relative(activeDir, targetPath) },
  };
}
