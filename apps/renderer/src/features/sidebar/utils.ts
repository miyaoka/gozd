import type { Task, WorktreeEntry } from "@gozd/proto";

/**
 * Task の body から表示可能なタイトル (一行目を trim) を取り出す。
 * 空文字 / `CLAUDE_PLACEHOLDER_TITLE` は「実質空」として undefined を返し、
 * 呼び出し側でフォールバック (branch 名 / "New session") に倒せるようにする。
 */
function extractTaskTitle(body: string): string | undefined {
  const [firstLine = ""] = body.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed === "" || trimmed === CLAUDE_PLACEHOLDER_TITLE) return undefined;
  return trimmed;
}

/**
 * Claude Code が transcript 起動直後に OSC タイトルとして送ってくる
 * プレースホルダ文字列。本物のタイトルが届くまでの中継値。
 * `useSidebarData` の OSC 受信側 early return と `taskDisplayTitle` の
 * 表示フォールバックの両方で SSOT として参照する。
 */
export const CLAUDE_PLACEHOLDER_TITLE = "Claude Code";

/**
 * Claude Code が OSC タイトルの先頭に付与するステータスプレフィックス
 * (`✳ ` + Braille spinner dots) を除去する。
 * 正規表現を 2 箇所以上に重複させないための SSOT。仕様変更時はここだけ直す。
 */
export function stripClaudeStatusPrefix(title: string): string {
  return title.replace(/^[✳⠀-⣿] /, "");
}

const DETACHED_BRANCH_LABEL = "(detached)";

/**
 * proto3 string は default が空文字なので `??` では detached を吸えない。
 * 「空文字 or undefined なら detached」を明示比較で判定する。
 */
export function branchLabel(branch: string | undefined): string {
  if (branch === undefined || branch === "") return DETACHED_BRANCH_LABEL;
  return branch;
}

/**
 * Task の PR / issue 番号をプレフィックス文字列 (`#123 `) として返す。
 * 両方 0 なら空文字。両方 > 0 は仕様上発生しないが、PR を優先する。
 */
function taskNumberPrefix(task: Task): string {
  if (task.prNumber > 0) return `#${task.prNumber} `;
  if (task.issueNumber > 0) return `#${task.issueNumber} `;
  return "";
}

/**
 * worktree の表示名: 任意 Task に有効なタイトルがあればそれ、なければブランチ名。
 * PR / issue 番号付き task は `#N タイトル` の形で先頭に番号を付ける。
 * Claude プレースホルダ (`CLAUDE_PLACEHOLDER_TITLE`) は無効扱いし、
 * confirm / error メッセージで "Claude Code" が露出するのを防ぐ。
 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  for (const task of wt.tasks) {
    const title = extractTaskTitle(task.body);
    if (title !== undefined) return `${taskNumberPrefix(task)}${title}`;
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
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/**
 * Task title を表示用に正規化。PR / issue 番号付き task は `#N タイトル` を返す。
 * body が空 (Claude プレースホルダ含む) の場合、番号ありなら `#N` 単体、番号無しなら
 * `New session` にフォールバックする。番号付きで body 空の状態は PR/issue picker 直後
 * (Claude 未起動 + OSC title 未到達) の過渡状態で、Not started アイコンと併せて識別される。
 */
export function taskDisplayTitle(task: Task): string {
  const prefix = taskNumberPrefix(task);
  const title = extractTaskTitle(task.body);
  if (title !== undefined) return `${prefix}${title}`;
  if (prefix !== "") return prefix.trimEnd();
  return "New session";
}
