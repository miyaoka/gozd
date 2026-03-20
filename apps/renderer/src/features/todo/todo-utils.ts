import type { WorktreeEntry } from "@orkis/rpc";

/** Todo の body 一行目をタイトルとして取得 */
export function todoTitle(body: string): string {
  const [firstLine] = body.split("\n");
  return firstLine ?? "";
}

/** worktree に Todo タイトルが設定されているか */
export function hasTodoTitle(wt: WorktreeEntry): boolean {
  return wt.todo?.body ? todoTitle(wt.todo.body) !== "" : false;
}

/** worktree の表示名: Todo タイトルがあればそれ、なければブランチ名 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  if (hasTodoTitle(wt)) return todoTitle(wt.todo!.body);
  return wt.branch ?? "(detached)";
}

/**
 * IME 変換中でない Enter キーのみ発火するガード。
 * WKWebView では isComposing が false のまま keyCode 229 が送られるため、
 * keyCode もチェックする。
 */
export function onEnterSubmit(e: KeyboardEvent, handler: () => void) {
  const IME_KEYCODE = 229;
  if (e.isComposing || e.keyCode === IME_KEYCODE || e.shiftKey) return;
  e.preventDefault();
  handler();
}
