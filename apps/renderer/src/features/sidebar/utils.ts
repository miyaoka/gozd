import type { Task, WorktreeEntry } from "@gozd/proto";

/**
 * Claude Code が transcript 起動直後に OSC タイトルとして送ってくる
 * プレースホルダ文字列。本物のタイトルが届くまでの中継値。
 * `useSidebarData` の OSC 受信側 early return と表示フォールバックの両方で SSOT として参照する。
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
 * terminal_title からタイトル候補を取り出す。
 * 1 行目を trim し、空文字 / `CLAUDE_PLACEHOLDER_TITLE` は無効扱いで undefined を返す。
 */
function extractTerminalTitle(terminalTitle: string): string | undefined {
  const [firstLine = ""] = terminalTitle.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed === "" || trimmed === CLAUDE_PLACEHOLDER_TITLE) return undefined;
  return trimmed;
}

/**
 * 表示優先度に沿って Task のタイトル候補を 1 つ返す。
 * 優先度: user_title > gh_title > terminal_title > undefined。
 * 編集 dialog の初期値解決にも使う。
 */
function resolveDisplayTitle(task: Task): string | undefined {
  if (task.userTitle !== "") return task.userTitle;
  if (task.ghTitle !== "") return task.ghTitle;
  return extractTerminalTitle(task.terminalTitle);
}

/**
 * user_title を除いたフォールバック候補を返す。input placeholder で「Save 時の見え方」を
 * 予告するために使う。優先度: gh_title > terminal_title > "New session"。
 */
export function fallbackTitle(task: Task): string {
  if (task.ghTitle !== "") return task.ghTitle;
  const term = extractTerminalTitle(task.terminalTitle);
  if (term !== undefined) return term;
  return "New session";
}

/**
 * Task の GitHub 参照番号をプレフィックス文字列 (`#123 `) として返す。
 * GitHub では PR と issue が同一の番号空間を共有するため kind を見ずに番号だけ表示する。
 */
function taskNumberPrefix(task: Task): string {
  if (task.ghRef === undefined) return "";
  return `#${task.ghRef.number} `;
}

/**
 * worktree の表示名: 任意 Task に有効なタイトルがあればそれ、なければブランチ名。
 * gh_ref 付き task は `#N タイトル` の形で先頭に番号を付ける。
 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  for (const task of wt.tasks) {
    const title = resolveDisplayTitle(task);
    if (title !== undefined) return `${taskNumberPrefix(task)}${title}`;
  }
  return branchLabel(wt.branch);
}

/** 変更ファイルがあるかどうか */
export function hasChanges(gitStatuses: Record<string, string> | undefined): boolean {
  if (!gitStatuses) return false;
  return Object.keys(gitStatuses).length > 0;
}

/**
 * Task title を表示用に正規化。gh_ref 付き task は `#N タイトル` を返す。
 * resolveDisplayTitle に従い、user_title > gh_title > terminal_title の順でフォールバック。
 * どれも空のとき、gh_ref ありなら `#N` 単体、無しなら `New session`。
 */
export function taskDisplayTitle(task: Task): string {
  const prefix = taskNumberPrefix(task);
  const title = resolveDisplayTitle(task);
  if (title !== undefined) return `${prefix}${title}`;
  if (prefix !== "") return prefix.trimEnd();
  return "New session";
}
