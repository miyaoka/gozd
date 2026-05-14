import type { WorktreeEntry } from "@gozd/proto";

/** Task の body 一行目をタイトルとして取得 */
function taskTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
}

/** worktree の表示名: Task タイトルがあればそれ、なければブランチ名 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  const [task] = wt.tasks;
  if (task?.body) {
    const title = taskTitle(task.body);
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
function dirName(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 経過時間を相対表記で返す。
 * <60s → `now`、<60m → `Nm`、<24h → `Nh`、>=24h → `Nd`。
 */
export function formatRelativeTime(from: number, now: number): string {
  const elapsed = Math.max(0, now - from);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/**
 * Task title を表示用に正規化。Claude Code のプレースホルダ / 空文字は
 * `New session` にフォールバックする。
 */
export function taskDisplayTitle(body: string): string {
  const [firstLine = ""] = body.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed === "" || trimmed === "Claude Code") return "New session";
  return trimmed;
}
