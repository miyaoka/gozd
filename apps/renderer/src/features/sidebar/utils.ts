import type { WorktreeEntry } from "@gozd/proto";

/** Task の body 一行目をタイトルとして取得 */
function taskTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
}

/**
 * Claude Code が transcript 起動直後に OSC タイトルとして送ってくる
 * プレースホルダ文字列。本物のタイトルが届くまでの中継値。
 * `useSidebarData` の OSC 受信側 early return と `taskDisplayTitle` の
 * 表示フォールバックの両方で SSOT として参照する。
 */
export const CLAUDE_PLACEHOLDER_TITLE = "Claude Code";

const DETACHED_BRANCH_LABEL = "(detached)";

/**
 * proto3 string は default が空文字なので `??` では detached を吸えない。
 * 「空文字 or undefined なら detached」を明示比較で判定する。
 */
export function branchLabel(branch: string | undefined): string {
  if (branch === undefined || branch === "") return DETACHED_BRANCH_LABEL;
  return branch;
}

/** worktree の表示名: Task タイトルがあればそれ、なければブランチ名 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  const [task] = wt.tasks;
  if (task?.body) {
    const title = taskTitle(task.body);
    if (title !== "") return title;
  }
  return branchLabel(wt.branch);
}

/** 変更ファイルがあるかどうか */
export function hasChanges(gitStatuses: Record<string, string> | undefined): boolean {
  if (!gitStatuses) return false;
  return Object.keys(gitStatuses).length > 0;
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
  const elapsed = now - from;
  // 未来時刻 (from > now) は時刻ソース異常の兆候。silent に `now` 表示で
  // 隠蔽すると診断不能になるため `?` で可視化する (規約: silent fallback 禁止)。
  if (elapsed < 0) return "?";
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/**
 * Task title を表示用に正規化。Claude プレースホルダ / 空文字は
 * `New session` にフォールバックする。
 */
export function taskDisplayTitle(body: string): string {
  const [firstLine = ""] = body.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed === "" || trimmed === CLAUDE_PLACEHOLDER_TITLE) return "New session";
  return trimmed;
}
