// Claude Code セッション関連の RPC 型。
//
// セッションの永続化自体は task.ts の Task.sessionId が SSOT (worktree 単位の
// resume 復元は ResumableSessionList で tasks.json から引く)。このファイルには PTY 単位の
// session 掃除 (RemoveByPty)、セッションログ表示 (ClaudeSessionLog)、削除済み worktree の
// セッション復活 (ReviveSession*) の RPC 型を置く。

import type { Task, WorktreeEntry } from "./common";

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

/** 削除済み worktree に紐づく、復活可能な 1 セッションの表示メタ。
 *
 * gozd 製 worktree を消すと cwd パスが失われ `claude --resume` の project key 解決が
 * 成立しなくなるが、セッションログ (~/.claude/projects/<enc>/<sid>.jsonl) は残る。
 * cwd を worktree として作り直せば resume できるため、その候補一覧を出すための行データ。
 * 復活対象は gozd 製 worktree に限定する (cwd が `worktrees/<projectKey>/<leaf>` 配下で、
 * projectKey が呼び出し repo と一致するもの)。 */
export interface ReviveSessionInfo {
  /** ~/.claude/projects/<enc>/<sessionId>.jsonl のファイル名から取る sessionId。resume の鍵。 */
  sessionId: string;
  /** ログ記録時の cwd (= 復活先 worktree の絶対パス)。resume の project key 一致条件。 */
  cwd: string;
  /** 復活 worktree の leaf (= basename(cwd)、元の作成タイムスタンプ)。createWorktree の worktreeDir。 */
  worktreeDir: string;
  /** ログ末尾の gitBranch (リネーム済みなら PR 用の名前、未リネームなら日付)。復活ブランチの第 1 候補。 */
  branch: string;
  /** セッションを識別する表示用タイトル。Claude 生成の要約 (`type:"ai-title"` の aiTitle の最新値)
   * で、gozd のターミナルタイトル (task.terminalTitle) と同一物。取れなければ空文字 (renderer が
   * branch にフォールバック)。 */
  title: string;
  /** セッションが最後に動いた時刻 (Unix ミリ秒)。ログ末尾レコードの `timestamp` (内容由来) を
   * SSOT にする。行の「最終日付」表示 + 新しい順ソートに使う。 */
  lastActivity: number;
  /** セッションログ jsonl のファイルサイズ (bytes)。会話量の目安として行に表示する。 */
  sizeBytes: number;
}

/** 指定 repo (dir) 配下の削除済み worktree に紐づく復活可能セッション一覧。
 * repo 詳細メニューの「復元」パネルが呼ぶ。dir は repo root / worktree / 配下 subdir の
 * いずれでも可 (main 側で projectKey に解決する)。 */
export interface ReviveSessionListRequest {
  dir: string;
}
export interface ReviveSessionListResponse {
  /** lastActivity 降順 (新しい順) で返す。復活候補が無ければ空配列。 */
  sessions: ReviveSessionInfo[];
}

/** セッション 1 件を復活させる。cwd を worktree として作り直し、tasks.json に sessionId 付き
 * task を書く。以降は既存の resume 機構 (visit 時の resumableSessionIds → `claude --resume`)
 * がそのまま resume を駆動する。branch は main 側で衝突判定する (他 worktree が占有中なら
 * 日付ブランチへ fallback) ため、renderer は候補 branch を渡すだけでよい。 */
export interface ReviveSessionRequest {
  /** repo root / 配下 dir。main 側で projectKey → worktree 配置先を解決する。 */
  dir: string;
  /** 復活先 worktree の leaf (= ReviveSessionInfo.worktreeDir)。cwd を 1 バイト一致で再現する。 */
  worktreeDir: string;
  /** 復活ブランチの第 1 候補 (= ReviveSessionInfo.branch)。衝突時は main 側で日付名に倒す。 */
  branch: string;
  /** 復活するセッションの sessionId。tasks.json の task.sessionId に載せて resume 起点にする。 */
  sessionId: string;
}
export interface ReviveSessionResponse {
  /** 作り直した worktree。renderer が repoStore.appendWorktree で即時反映する。 */
  worktree: WorktreeEntry;
  /** 作成した worktree の絶対パス。renderer が worktreeStore.setOpen で開く。 */
  dir: string;
  /** sessionId を載せた task。サイドバーに即時表示する。 */
  task: Task;
  /** project 設定の setupScript。renderer が専用ターミナルで実行する。空なら実行しない。 */
  setupScript: string;
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
