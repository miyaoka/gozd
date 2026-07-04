// CLI / nc から SocketServer へ送られるメッセージ。
// NDJSON 1 行 = 1 ClientMessage。
//
// ワイヤ形状は旧 proto3 oneof の JSON mapping（`{"hook":{...}}` / `{"open":{...}}`）を
// そのまま維持する。nc 直送コマンドに固定 JSON として埋め込める:
//
//   echo '{"hook":{"event":"running","ptyId":'"$GOZD_PTY_ID"'}}' | nc -w 1 -U "$GOZD_SOCKET_PATH"
//
// hook / open は最大 1 つだけ設定される（両方 undefined は不正メッセージとして
// 受信側でログの上 drop する）。

export interface ClientMessage {
  hook?: HookMessage;
  open?: OpenMessage;
}

/** Claude Code の hook イベント通知。
 * 軽量な nc 直送経路では event / ptyId のみが JSON に載る（他フィールドはキー不在）。
 * 受信側 (socketMessages.ts) が default 充填してから使う契約。
 * CLI 経由の rich 経路では全フィールドが埋まる。 */
export interface HookMessage {
  /** "session-start" / "session-end" / "running" / "done" / "needs-input" /
   * "tool-done" / "tool-failure" / "stop-failure" */
  event: string;
  ptyId: number;

  /** CLI 経由のみ */
  lastAssistantMessage: string;
  toolName: string;
  /** Claude Code の tool_input をそのまま JSON 文字列として保持 */
  toolInput: string;

  /** session-start / session-end のみ。Claude Code の resume 起動に必要。 */
  sessionId: string;

  /** "done" (Stop) のみ。Stop 発火時に background_tasks / session_crons のいずれかが
   * 残っているか。CLI が stdin の 2 配列を OR で畳んで立てる。true のときは主エージェントの
   * ターンは終わったが裏で作業が継続中（= 再起動する）ため、真の done ではない。 */
  pendingWork: boolean;

  /** session-start のみ。"startup" / "resume" / "clear" / "compact" 等 */
  source: string;
}

/** `gozd open <path>` から送られるプロジェクトを開けの指示。 */
export interface OpenMessage {
  targetPath: string;
}
