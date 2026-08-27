/**
 * 起動できずに渡せなかった指示文を、通知の文面に添えるための整形。
 *
 * `gozd worktree new` が渡す指示文は、claude が `claude -- <text>` で起動するまで
 * どこにも残らない（push payload と spawn env にしか無い）。起動までのどこかで失敗すると
 * 指示文はそこで消えるため、**失敗をユーザーに見せるときは必ず本文を添える** —
 * 添えないと「何かが失敗した」ことしか分からず、手で渡し直せない。
 *
 * 起動が成功した後は claude のセッションが指示文を保持するので、この整形の出番は無い。
 */
export function lostPromptDetail(prompt: string | undefined): string {
  if (prompt === undefined || prompt === "") return "";
  return ` The instruction was not delivered: ${prompt}`;
}
