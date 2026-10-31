import type { WorktreeEntry } from "@gozd/rpc";

/** ワイヤ契約では detached HEAD を空文字の branch で表現する */
export function isDetached(branch: string): boolean {
  return branch === "";
}

/** path の末尾のディレクトリ名 */
export function pathBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** worktree の表示名。branch を持てば branch 名、detached なら末尾のディレクトリ名 */
export function worktreeLabel(wt: Pick<WorktreeEntry, "branch" | "path">): string {
  return isDetached(wt.branch) ? pathBaseName(wt.path) : wt.branch;
}
