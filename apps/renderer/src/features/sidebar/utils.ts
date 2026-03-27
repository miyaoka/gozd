import type { WorktreeChangeCounts, WorktreeEntry } from "@gozd/rpc";

/** Task の body 一行目をタイトルとして取得 */
export function taskTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
}

/** worktree に Task タイトルが設定されているか */
export function hasTaskTitle(wt: WorktreeEntry): boolean {
  if (!wt.task?.body) return false;
  return taskTitle(wt.task.body) !== "";
}

/** worktree の表示名: Task タイトルがあればそれ、なければブランチ名 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  if (wt.task?.body) {
    const title = taskTitle(wt.task.body);
    if (title !== "") return title;
  }
  return wt.branch ?? "(detached)";
}

/** 変更ファイルがあるかどうか */
export function hasChanges(counts: WorktreeChangeCounts | undefined): boolean {
  if (!counts) return false;
  return counts.modified + counts.added + counts.deleted + counts.untracked > 0;
}

/** パスから末尾のディレクトリ名を取得 */
export function dirName(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}
