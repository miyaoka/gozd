// Claude Code のセッション一覧。
//
// セッションの記録（どこで動いたか、タイトル、最終更新）は Claude Code のセッションログが
// SSOT で、gozd は写しを持たない。ログの置き場所の規則と、タイトルの決め方
// （ユーザーの名前 → Claude の名前 → 最初のプロンプト）は Claude 側の内部仕様なので、
// 公式 SDK の関数に任せて gozd では再構成しない。

import type { ClaudeSessionSummary } from "@gozd/rpc";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

/** repo（本体と全 git worktree）で動いた対話セッションを lastModified 降順で返す。
 * git 管理外の dir はその dir 自身のセッションを返す。 */
export async function listClaudeSessions(dir: string): Promise<ClaudeSessionSummary[]> {
  const sessions = await listSessions({
    dir,
    includeWorktrees: true,
    // SDK / `-p` で起動した非対話のセッションは作業の一覧に出さない（`/resume` と同じ基準）
    includeProgrammatic: false,
  });
  return sessions
    .map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd ?? "",
      title: s.summary,
      lastModified: s.lastModified,
    }))
    .toSorted((a, b) => b.lastModified - a.lastModified);
}
