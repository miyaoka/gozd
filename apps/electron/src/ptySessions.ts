// PTY ⇔ Claude session の紐付け registry。
// PTY 本体（node-pty instance）は utilityProcess（ptyHost）が所有し、本モジュールは
// ptyId 単位の紐付けのみ扱う（pty オブジェクトには依存しない）。
// socket 経由の hook 処理（socketMessages）と RPC（routes）の両方から参照される。

const worktreePathById = new Map<number, string>();
const sessionIdById = new Map<number, string>();
// 削除 RPC で紐付けが消された ptyId 集合。late session-start hook の観察ログで
// 「明示削除後の late hook」と「未登録 PTY」を区別するために使う。
// spawn 成功 ptyId は単調増加で再利用されないため、集合に残しても偽陽性は出ない
const explicitlyRemovedPtyIds = new Set<number>();

export function registerSpawn(ptyId: number, worktreePath: string): void {
  if (worktreePath !== "") worktreePathById.set(ptyId, worktreePath);
}

/** PTY 子プロセス消滅（onExit）時の掃除 */
export function unregisterExit(ptyId: number): void {
  worktreePathById.delete(ptyId);
  sessionIdById.delete(ptyId);
}

export function worktreePathFor(ptyId: number): string {
  return worktreePathById.get(ptyId) ?? "";
}

export function sessionIdFor(ptyId: number): string {
  return sessionIdById.get(ptyId) ?? "";
}

/** hook の session-start 受信時に呼ぶ。同 ptyId への複数 session-start（/clear や --resume）も
 * 上書きで反映する */
export function setSessionId(ptyId: number, sessionId: string): void {
  sessionIdById.set(ptyId, sessionId);
}

export function clearSessionId(ptyId: number): void {
  sessionIdById.delete(ptyId);
}

/** removeByPty から呼ぶ。worktreePath / sessionId の紐付けを両方クリアし、late
 * session-start hook を worktreePath 空ガードで弾けるようにする */
export function clearAssociations(ptyId: number): void {
  worktreePathById.delete(ptyId);
  sessionIdById.delete(ptyId);
  explicitlyRemovedPtyIds.add(ptyId);
}

export function wasExplicitlyRemoved(ptyId: number): boolean {
  return explicitlyRemovedPtyIds.has(ptyId);
}

/** gozd の端末で Claude セッションが紐付いている PTY の (sessionId, worktreePath) 一覧 */
export function liveSessions(): Array<{ sessionId: string; worktreePath: string }> {
  const sessions: Array<{ sessionId: string; worktreePath: string }> = [];
  for (const [ptyId, sessionId] of sessionIdById) {
    sessions.push({ sessionId, worktreePath: worktreePathById.get(ptyId) ?? "" });
  }
  return sessions;
}
