import type { WorktreeChangeCounts, WorktreeEntry } from "@gozd/rpc";

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

/** worktree 用のタイムスタンプを生成する（YYYYMMDD_HHMMSS 形式） */
export function generateTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

/** パスから末尾のディレクトリ名を取得 */
export function dirName(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}
