import path from "node:path";
import { tryCatch } from "@orkis/shared";

/** remote URL から owner/repo を抽出するパターン（HTTPS / SSH / ssh:// 対応、ローカルパスは除外） */
const REMOTE_OWNER_REPO_RE =
  /^(?:(?:https?|ssh):\/\/[^/]+\/|[^@]+@[^:]+:)([^/:]+\/[^/]+?)(?:\.git)?$/;

/** remote URL から owner/repo 形式の名前を抽出する。マッチしなければ undefined */
export function parseOwnerRepo(url: string): string | undefined {
  const match = url.match(REMOTE_OWNER_REPO_RE);
  return match?.[1];
}

/**
 * dir から git リポジトリルート（main worktree）を同期的に解決する。
 * --git-common-dir で共通 .git ディレクトリを取得し、その親をルートとする。
 * worktree 内で実行しても main worktree のルートが返る。
 * git 管理外や失敗時はそのまま返す。
 */
export function resolveRepoRoot(dir: string): string {
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
