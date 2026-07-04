// Claude Code セッション関連の RPC 型。
//
// セッションの永続化自体は task.ts の Task.sessionId が SSOT (worktree 単位の
// resume 復元は ResumableSessionList で tasks.json から引く)。このファイルには PTY 単位の
// session 掃除 (RemoveByPty) とセッションログ表示 (ClaudeSessionLog) の RPC 型のみ置く。

/** 指定 PTY に紐づく Claude セッションを永続化から削除する。renderer の
 * unregisterPane（terminal.closePane / resetLayout / worktree 削除）から呼ぶ。
 * session-end hook 経路ではなく PTY 単位の明示的削除なので、worktreePath も
 * 併せて受け取って projectKey 解決を確定させる。ptyId に紐づく sessionId は
 * main 側の PTY registry が保持する。 */
export interface ClaudeSessionRemoveByPtyRequest {
  ptyId: number;
  worktreePath: string;
}

export interface ClaudeSessionRemoveByPtyResponse {
  /** 削除した sessionId。renderer が repoStore の WorktreeEntry.tasks から
   * 該当 Task を即時削除するために使う。pty に session が紐付いていなかった
   * 場合は空文字。 */
  removedSessionId: string;
}

/** Claude Code が ~/.claude/projects/<cwd エンコード>/<session_id>.jsonl に書き出した
 * セッションログ (JSONL) を読む。サイドバー task メニューの「セッションログ表示」と
 * ターミナル右上の preview overlay (TerminalSessionPreview) の両方で使う。
 *
 * sessionId (UUID) は jsonl 名に必ず現れるため、main 側が
 * ~/.claude/projects/*\/<session_id>.jsonl を解決する。Claude の dir encoding 規則
 * (`/` `.` → `-`) は内部仕様で将来変わりうるため、gozd 側で再構成しない。 */
export interface ClaudeSessionLogRequest {
  sessionId: string;
}

/** セッションログ 1 本分 (main または subagent)。parse は renderer 側が担う。 */
interface ClaudeSessionLogEntry {
  /** "main" (本体セッション) または "subagent" (Task / Workflow ツールで起動したサブエージェント)。
   * workflow agent かどうかは workflowRunId の有無で判別する。 */
  kind: string;
  /** main は sessionId、subagent は agentId。 */
  id: string;
  /** subagent のラベル (meta.json の description)。main は空文字。 */
  label: string;
  /** subagent の agentType (meta.json)。main は空文字。 */
  agentType: string;
  /** jsonl の絶対パス。 */
  path: string;
  /** jsonl の生内容 (改行区切り)。 */
  content: string;
  /** この subagent を spawn した main 側 Agent tool_use の id (meta.json の toolUseId)。
   * main の Agent tool_use と subagent を結ぶキー。main entry は空文字。
   * SendMessage による resume は別キー (main tool_use の input.to == この entry の id or name)
   * で結ぶため、この field には現れない (resume では新規 subagent が作られないため)。 */
  parentToolUseId: string;
  /** subagent の名前 (meta.json の name)。SendMessage の input.to は agentId だけでなく
   * agent name のこともあるため、id と name の双方で resume を紐付けられるよう露出する。
   * 名前付きで起動していない subagent / main は空文字。 */
  name: string;
  /** この subagent が属する workflow run の id (wf_xxx)。Workflow ツールが spawn した
   * workflow agent のみ非空。Task ツール subagent / main は空文字。main の Workflow
   * tool_use と結ぶグループキー (main の Workflow tool_result の "Run ID: wf_xxx" と一致)。 */
  workflowRunId: string;
  /** workflow の表示名 (<sessionId>/workflows/<wf_id>.json の workflowName)。
   * タブバーのグループ見出しに使う。非 workflow subagent / main は空文字。 */
  workflowName: string;
  /** workflow agent の phase 名 (workflowProgress の phaseTitle)。タブのラベルに使う。
   * 非 workflow subagent / main は空文字。 */
  phaseTitle: string;
}

export interface ClaudeSessionLogResponse {
  /** main の jsonl が glob で見つかったか。未起動 / cleanup 済みセッションでは false。 */
  found: boolean;
  /** entries[0] が main、残りが subagents (見つかった順)。found=false なら空。
   * Task ツール subagent は ~/.claude/projects/<encoded>/<session_id>/subagents/agent-*.jsonl、
   * Workflow agent は同 subagents/workflows/<wf_id>/agent-*.jsonl に isSidechain ログとして
   * 並ぶ。main の projectDir を起点に両方を列挙する。 */
  entries: ClaudeSessionLogEntry[];
  /** ライブ更新で renderer 側が fsWatch を張る親 dir。非空なら実在を保証する。
   *   - found=true:                     main jsonl の親 dir (~/.claude/projects/<encoded>/)
   *   - found=false && projects 親実在: ~/.claude/projects/ (projects 親)
   *   - found=false && projects 親不在: 空文字 (Claude 未起動環境など、renderer で error 化)
   * 新規セッションの JSONL は最初の UserPromptSubmit まで作られない。!found 時は projects
   * 親を返し、renderer は当該 sessionId の JSONL 出現を fsChange で検知して再 load する。
   * 次の load 結果で found に転じたら main jsonl 親 dir に張り替える。fsChange の
   * cross-session ノイズは debounce で coalesce する (refresh の per-call cost は constant)。 */
  watchDir: string;
}
