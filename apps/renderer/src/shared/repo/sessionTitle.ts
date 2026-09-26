/**
 * Claude Code が transcript 起動直後に OSC タイトルとして送ってくる
 * プレースホルダ文字列。本物のタイトルが届くまでの中継値。
 */
const CLAUDE_PLACEHOLDER_TITLE = "Claude Code";

/** タイトルが 1 つも取れないセッションの表示 */
const UNTITLED_SESSION = "New session";

/**
 * 端末タイトルからセッションのタイトル候補を取り出す。
 * 1 行目を trim し、空文字 / `CLAUDE_PLACEHOLDER_TITLE` は無効扱いで undefined を返す。
 */
function extractTerminalTitle(terminalTitle: string): string | undefined {
  const [firstLine = ""] = terminalTitle.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed === "" || trimmed === CLAUDE_PLACEHOLDER_TITLE) return undefined;
  return trimmed;
}

/**
 * セッションの表示タイトル。
 *
 * 端末が開いているセッションは、稼働中の Claude が端末タイトルとして送る値を優先する。
 * `/rename` や Claude の命名はまず端末タイトルに現れ、セッション一覧（Claude のセッションログが
 * SSOT）は読み直すまで追従しないため。端末タイトルが取れないとき（端末が閉じている、
 * プレースホルダしか届いていない）は一覧のタイトルを使う。どちらも無ければ `UNTITLED_SESSION`。
 */
export function sessionDisplayTitle(
  listTitle: string | undefined,
  terminalTitle: string | undefined,
): string {
  const live = terminalTitle === undefined ? undefined : extractTerminalTitle(terminalTitle);
  if (live !== undefined) return live;
  if (listTitle !== undefined && listTitle !== "") return listTitle;
  return UNTITLED_SESSION;
}
