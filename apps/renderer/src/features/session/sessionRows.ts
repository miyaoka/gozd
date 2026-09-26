import type { ClaudeSessionSummary } from "@gozd/rpc";
import { sessionDisplayTitle } from "../../shared/repo";
import type { ClaudeStatus, LiveSession } from "../terminal";

/** サイドバー / ダッシュボードが描く 1 セッション */
export interface SessionRow {
  sessionId: string;
  /** セッションの作業ディレクトリ（worktree / 非 git project の root） */
  dir: string;
  title: string;
  /** 端末が開いているか */
  live: boolean;
  /** 端末が開いているセッションの Claude 状態。開いていなければ undefined */
  status: ClaudeStatus | undefined;
  /** 並びと相対時刻の基準（Unix ミリ秒）。稼働中は Claude の最終活動、それ以外はログの最終更新。
   * 端末は開いたがログがまだ無いセッション（最初のプロンプト前）は undefined */
  lastActivity: number | undefined;
}

/** 1 つの作業ディレクトリのセッション行。端末が開いているものを上、それ以外を下に分ける */
export interface DirSessionRows {
  live: SessionRow[];
  inactive: SessionRow[];
}

/** lastActivity 降順。undefined（まだ記録の無い新しいセッション）は先頭に置く */
export function compareRecentFirst(a: SessionRow, b: SessionRow): number {
  return (b.lastActivity ?? Infinity) - (a.lastActivity ?? Infinity);
}

/**
 * 端末が開いているセッション（`liveSessions`）と、Claude のセッションログから読んだ一覧
 * （`listed`）を 1 つの作業ディレクトリについて合わせる。
 *
 * - 端末が開いているセッションは、ログに現れる前（最初のプロンプト前）でも行にする
 * - 端末を閉じたセッションは、ログの最終更新が最も新しいため下の先頭に来る
 * - どちらもそれぞれの中で新しい順に並べる
 */
export function buildSessionRows(
  dir: string,
  liveSessions: readonly LiveSession[],
  listed: readonly ClaudeSessionSummary[],
): DirSessionRows {
  const listedById = new Map(listed.map((s) => [s.sessionId, s]));
  const live = liveSessions
    .filter((s) => s.dir === dir)
    .map((s): SessionRow => {
      const summary = listedById.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        dir,
        title: sessionDisplayTitle(summary?.title, s.terminalTitle),
        live: true,
        status: s.status,
        lastActivity: s.status?.lastActivityAt ?? summary?.lastModified,
      };
    })
    .toSorted(compareRecentFirst);
  const liveIds = new Set(live.map((row) => row.sessionId));
  const inactive = listed
    .filter((s) => s.cwd === dir && !liveIds.has(s.sessionId))
    .map((s): SessionRow => ({
      sessionId: s.sessionId,
      dir,
      title: sessionDisplayTitle(s.title, undefined),
      live: false,
      status: undefined,
      lastActivity: s.lastModified,
    }))
    .toSorted(compareRecentFirst);
  return { live, inactive };
}
