/**
 * 渡せなかった起動時の指示文を、手で渡し直せる形で通知に出す。
 *
 * `gozd worktree new` の指示文は、claude が `claude -- <text>` で起動するまでどこにも
 * 残らない。起動までのどこかで失敗したら本文ごと出さないと、何が失われたか分からない。
 *
 * **会話の複製が失われたら、複製元のセッションも出す。** 指示文だけを渡し直すと、会話の無い
 * セッションが前提を欠いたまま作業を始める。指示文の無い複製も、出さなければ失われたことが
 * 分からない。
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
import type { AutostartHint } from "./autostartHint";

/** 通知の発火口。store 全体に依存させないための最小の形 */
export interface ErrorNotifier {
  error: (message: string, cause?: unknown) => void;
}

const LOST_PROMPT_MESSAGE = "The instruction was not delivered. Open details to copy it.";
const LOST_FORK_MESSAGE =
  "The forked session was not started. Open details to copy the command to start it.";
const LOST_FORK_WITH_PROMPT_MESSAGE =
  "The forked session was not started. Open details to copy the command and the instruction.";

/**
 * 起動時に渡すはずだった指示文と複製が届かなかったことを通知する。どちらも無い経路では何もしない。
 * dir は起動するはずだった worktree。複製は実行したディレクトリに属するため、コマンドに添える。
 */
export function notifyLostPrompt(
  notify: ErrorNotifier,
  hint: AutostartHint | undefined,
  dir: string,
): void {
  const prompt = hint?.prompt ?? "";
  const forkSessionId = hint?.forkSessionId ?? "";
  if (forkSessionId !== "") {
    const command = `cd "${dir}"\nclaude --resume ${forkSessionId} --fork-session`;
    if (prompt === "") {
      notify.error(LOST_FORK_MESSAGE, command);
    } else {
      notify.error(LOST_FORK_WITH_PROMPT_MESSAGE, `${command}\n\n${prompt}`);
    }
    return;
  }
  if (prompt === "") return;
  notify.error(LOST_PROMPT_MESSAGE, prompt);
}
