/**
 * worktree 初回 visit 時に復元する Claude セッションの sessionId 列を組み立てる。
 *
 * - `savedSessionIds`: `claude-sessions.json` 由来の自動復元対象 (複数 leaf 復元用)
 * - `preferred`: サイドバーで resumable / closed task を click したケースの
 *   `task.sessionId` (= resume 対象の SSOT)。`undefined` なら自動復元のみ
 *
 * preferred は saved リストに含まれなくても (session-end hook で消えた closed session
 * の通常ケース) 必ず先頭 (= initial focused leaf) に置く。先頭要素が initial leaf、
 * 残りが split leaf に割り当たるため、列の長さと先頭が leaf 構成を決める決定点になる。
 * preferred が saved に既に含まれる場合は重複を除外する。
 */
export function buildResumeSessionIds(
  preferred: string | undefined,
  savedSessionIds: string[],
): string[] {
  if (preferred === undefined) return savedSessionIds;
  return [preferred, ...savedSessionIds.filter((id) => id !== preferred)];
}
