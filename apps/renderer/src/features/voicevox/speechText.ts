/** マークダウン記法を除去して一行目の最初の句点（「。」）までを取得する */
export function extractFirstSentence(message: string): string | undefined {
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const stripped = trimmed.replace(/[*_`#]/g, "");
    const periodIndex = stripped.indexOf("。");
    if (periodIndex !== -1) return stripped.slice(0, periodIndex + 1);
    return stripped;
  }
  return undefined;
}

/** asking 時のテキストを抽出する: AskUserQuestion なら質問内容、それ以外はツール名 */
export function extractAskingText(
  toolName: string | undefined,
  toolInput: unknown,
): string | undefined {
  if (
    toolName === "AskUserQuestion" &&
    typeof toolInput === "object" &&
    toolInput !== null &&
    "questions" in toolInput &&
    Array.isArray(toolInput.questions)
  ) {
    const [first] = toolInput.questions;
    if (
      typeof first === "object" &&
      first !== null &&
      "question" in first &&
      typeof first.question === "string"
    ) {
      return first.question;
    }
  }
  return toolName;
}

/** payload からイベントに応じた読み上げテキストを抽出する */
export function extractSpeechText(
  event: string,
  payload: Record<string, unknown>,
): string | undefined {
  if (event === "done") {
    const message =
      typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : undefined;
    if (message) return extractFirstSentence(message);
    return undefined;
  }
  if (event === "needs-input") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const text = extractAskingText(toolName, payload.tool_input);
    if (text) return extractFirstSentence(text) ?? text;
    return undefined;
  }
  return undefined;
}
