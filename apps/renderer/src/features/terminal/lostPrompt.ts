/**
 * 渡せなかった起動時の指示文を、手で渡し直せる形で通知に出す。
 *
 * `gozd worktree new` の指示文は、claude が `claude -- <text>` で起動するまでどこにも
 * 残らない。起動までのどこかで失敗したら本文ごと出さないと、何が失われたか分からない。
 *
 * **本文は message ではなく cause に載せる。** message は toast にそのまま描かれるが、
 * toast は高さ上限も改行の保持も持たないため、長文・複数行の指示文（`--prompt-stdin` は
 * 複数行を 1 つの値として受ける）を置くと画面を覆い、改行が潰れてコピーしても元に戻らない。
 * cause 側の詳細パネルは高さ上限・スクロール・改行保持・Copy を備えており、verbatim な
 * テキストの置き場として設計されている。文字列の cause はそのまま表示される。
 *
 * 失敗そのものの通知とは別に出す。原因（端末が起動できない）と復旧の手立て（この指示文を
 * 渡し直す）は別の情報で、cause の 1 枠を奪い合わせると診断か復旧のどちらかが消える。
 */

/** 通知の発火口。store 全体に依存させないための最小の形 */
export interface ErrorNotifier {
  error: (message: string, cause?: unknown) => void;
}

const LOST_PROMPT_MESSAGE = "The instruction was not delivered. Open details to copy it.";

/** 指示文が渡らずに終わったことを通知する。指示文が無い経路では何もしない */
export function notifyLostPrompt(notify: ErrorNotifier, prompt: string | undefined): void {
  if (prompt === undefined || prompt === "") return;
  notify.error(LOST_PROMPT_MESSAGE, prompt);
}

/** 起動ヒント。spawn env へ渡すテキストを持つ */
export interface AutostartHintLike {
  prompt?: string;
  prefill?: string;
}

/**
 * spawn 失敗時に leaf の起動ヒントを消費する。読み取りと削除を 1 か所に閉じ、
 * 「読んだのに消し忘れる」「消してから読もうとする」のどちらも起きない形にする。
 */
export function consumeAutostartHint<T extends AutostartHintLike>(
  hints: Record<string, T>,
  leafId: string,
): T | undefined {
  const hint = hints[leafId];
  delete hints[leafId];
  return hint;
}
