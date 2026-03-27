import type { WorktreeEntry } from "@gozd/rpc";

/** Task の body 一行目をタイトルとして取得 */
function taskTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
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
export function hasChanges(gitStatuses: Record<string, string> | undefined): boolean {
  if (!gitStatuses) return false;
  return Object.keys(gitStatuses).length > 0;
}

/** パスから末尾のディレクトリ名を取得 */
export function dirName(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}
