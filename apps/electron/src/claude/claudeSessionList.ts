// Claude Code のセッション一覧。
//
// セッションの記録（どこで動いたか、タイトル、最終更新）は Claude Code のセッションログが
// SSOT で、gozd は写しを持たない。ログの置き場所の規則と、タイトルの決め方
// （ユーザーの名前 → Claude の名前 → プロンプトの本文）は Claude 側の内部仕様なので、
// 公式 SDK の関数に任せて gozd では再構成しない。

import type { ClaudeSessionSummary } from "@gozd/rpc";
import { getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";

/** repo（本体と全 git worktree）で動いた対話セッションを lastModified 降順で返す。
 * git 管理外の dir はその dir 自身のセッションを返す。 */
export async function listClaudeSessions(dir: string): Promise<ClaudeSessionSummary[]> {
  const sessions = await listSessions({
    dir,
    includeWorktrees: true,
    // SDK / `-p` で起動した非対話のセッションは作業の一覧に出さない（`/resume` と同じ基準）
    includeProgrammatic: false,
  });
  const summaries: ClaudeSessionSummary[] = [];
  for (const s of sessions) {
    // 作業ディレクトリの無いセッションはどの worktree にも帰属できない
    if (s.cwd === undefined) {
      console.error(`[listClaudeSessions] session without cwd, skipping: ${s.sessionId}`);
      continue;
    }
    summaries.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.summary,
      lastModified: s.lastModified,
    });
  }
  return summaries.toSorted((a, b) => b.lastModified - a.lastModified);
}

/** セッションを起動した作業ディレクトリ。セッションが見つからない、または作業ディレクトリを
 * 持たないときは undefined */
export async function claudeSessionCwd(sessionId: string): Promise<string | undefined> {
  const info = await getSessionInfo(sessionId);
  return info?.cwd;
}
