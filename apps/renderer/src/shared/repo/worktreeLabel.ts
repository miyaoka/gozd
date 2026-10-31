import type { WorktreeEntry } from "@gozd/rpc";

/** path の末尾のディレクトリ名 */
export function pathBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** worktree の表示名。branch を持てば branch 名、持たなければ（detached / bare）末尾のディレクトリ名 */
export function worktreeLabel(wt: Pick<WorktreeEntry, "branch" | "path">): string {
  return wt.branch === "" ? pathBaseName(wt.path) : wt.branch;
}
