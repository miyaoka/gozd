import type { Task } from "@gozd/proto";

/**
 * Claude Code が transcript 起動直後に OSC タイトルとして送ってくる
 * プレースホルダ文字列。本物のタイトルが届くまでの中継値。
 * `useSidebarData` の OSC 受信側 early return と表示フォールバックの両方で SSOT として参照する。
 */
export const CLAUDE_PLACEHOLDER_TITLE = "Claude Code";

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
export function resolveDisplayTitle(task: Task): string | undefined {
  if (task.userTitle !== "") return task.userTitle;
  if (task.ghTitle !== "") return task.ghTitle;
  return extractTerminalTitle(task.terminalTitle);
}

/**
 * Task の GitHub 参照番号をプレフィックス文字列 (`#123 `) として返す。
 * GitHub では PR と issue が同一の番号空間を共有するため kind を見ずに番号だけ表示する。
 */
export function taskNumberPrefix(task: Task): string {
  if (task.ghRef === undefined) return "";
  return `#${task.ghRef.number} `;
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
