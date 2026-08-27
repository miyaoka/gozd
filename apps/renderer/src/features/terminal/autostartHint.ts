/**
 * autostart で claude へ渡すテキストの型と、その消費。
 *
 * 型と消費を leaf module に置くのは、ヒントを積む側（store）と、渡せずに終わったときに
 * 通知する側（`lostPrompt.ts`）の両方がこれを見るため。store 側に置くと通知側から
 * 参照できず（store が通知側を import しているので循環になる）、構造だけ同じ型が
 * 2 つに割れる。
 */

/**
 * autostart 時に claude へ渡すテキスト。渡し方が 2 通りあり、**送信されるかどうかが違う**。
 *
 * - `prefill`: `claude --prefill <text>` で入力欄に挿入するだけ。送信は人が行う。
 *   PR/issue picker が worktree 作成時に PR/issue URL を渡す用途
 * - `prompt`: `claude <text>` と引数で渡す。起動と同時に送信され実行が始まる。
 *   `gozd worktree new` が作業指示を渡す用途（切り出す側は相手が動き出すまでを指示している）
 *
 * 同時には片方しか意味を持たない。両方あるときは prompt を優先する。
 */
export type AutostartHint = { prefill?: string; prompt?: string };

/**
 * leaf に積まれた起動ヒントを消費する。読み取りと削除を 1 か所に閉じ、
 * 「読んだのに消し忘れる」「消してから読もうとする」のどちらも書けない形にする。
 */
export function consumeAutostartHint(
  hints: Record<string, AutostartHint>,
  leafId: string,
): AutostartHint | undefined {
  const hint = hints[leafId];
  delete hints[leafId];
  return hint;
}
