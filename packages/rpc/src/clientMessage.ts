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
   * "tool-done" / "tool-failure" / "stop-failure" / "subagent-start" /
   * "subagent-stop" / "teammate-idle" */
  event: string;
  ptyId: number;

  /** CLI 経由のみ */
  lastAssistantMessage: string;
  toolName: string;
  /** Claude Code の tool_input をそのまま JSON 文字列として保持 */
  toolInput: string;

  /** session-start / session-end のみ。Claude Code の resume 起動に必要。 */
  sessionId: string;

  /** "done" (Stop) のみ。Stop 発火時に background_tasks（type "teammate" を除く）/
   * session_crons のいずれかが残っているか。CLI が stdin の 2 配列を OR で畳んで立てる。
   * true のときは主エージェントのターンは終わったが裏で作業が継続中（= 再起動する）ため、
   * 真の done ではない。
   *
   * teammate 型を数えないのは、teammate（Agent ツールの name 付き spawn）が idle 化しても
   * background_tasks に status "running" のまま session 終了まで残り続けるため（完了の概念が
   * entry の除去に接続されていない）。数えると一度 teammate を spawn した session が永続的に
   * working 表示になる。teammate の稼働判定は renderer が subagent lifecycle hook
   * （subagent-start / subagent-stop / teammate-idle）の台帳で行う。 */
  pendingWork: boolean;

  /** "done" (Stop) のみ。background_tasks に type "teammate" のエントリが残っているか。
   * false は「teammate 形状の子は生存し得ない」完全な台帳の証明なので、renderer が
   * lifecycle hook を取りこぼして残留した teammate 台帳の掃除ガードに使う。 */
  hasTeammateTask: boolean;

  /** "subagent-start" / "subagent-stop" のみ。Claude Code が子エージェントに振る一意 id。
   * teammate は `a<name>-<hex>` 形状、one-shot subagent は `a<hex>` 形状。 */
  agentId: string;

  /** "teammate-idle" のみ。idle に遷移した teammate の名前。 */
  teammateName: string;

  /** session-start のみ。"startup" / "resume" / "clear" / "compact" 等 */
  source: string;
}

/** `gozd open <path>` から送られるプロジェクトを開けの指示。 */
export interface OpenMessage {
  targetPath: string;
}
