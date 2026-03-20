import type { WorktreeChangeCounts, WorktreeEntry } from "@orkis/rpc";

/** Todo の body 一行目をタイトルとして取得 */
export function todoTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
}

/** worktree に Todo タイトルが設定されているか */
export function hasTodoTitle(wt: WorktreeEntry): boolean {
  if (!wt.todo?.body) return false;
  return todoTitle(wt.todo.body) !== "";
}

/** worktree の表示名: Todo タイトルがあればそれ、なければブランチ名 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  if (wt.todo?.body) {
    const title = todoTitle(wt.todo.body);
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
