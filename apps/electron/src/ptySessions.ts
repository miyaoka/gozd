// PTY ⇔ Claude session の紐付け registry。Swift 版 `PTYRegistry` の per-id state
// （worktreePathById / sessionIdById / expectedResumeSidById / explicitlyRemovedPtyIds）の対応物。
// PTY 本体（node-pty instance）は utilityProcess（ptyHost）が所有し、本モジュールは
// ptyId 単位の紐付けのみ扱う（pty オブジェクトには依存しない）。
// socket 経由の hook 処理（claudeSessionHooks）と RPC（routes）の両方から参照される。

const worktreePathById = new Map<number, string>();
const sessionIdById = new Map<number, string>();
// ptyId → spawn 時の env[GOZD_RESUME_CLAUDE_SESSION] (resume 期待 sid)。
// SessionStart hook 着弾時に必ず consume する。unregisterPane（removeByPty）時点で
// 残っているなら「SessionStart 不達 = resume 失敗」と判定して task から掃除する
const expectedResumeSidById = new Map<number, string>();
// 削除 RPC で紐付けが消された ptyId 集合。late session-start hook の観察ログで
// 「明示削除後の late hook」と「未登録 PTY」を区別するために使う。
// spawn 成功 ptyId は単調増加で再利用されないため、集合に残しても偽陽性は出ない
const explicitlyRemovedPtyIds = new Set<number>();

export function registerSpawn(
  ptyId: number,
  worktreePath: string,
  expectedResumeSid: string,
): void {
  if (worktreePath !== "") worktreePathById.set(ptyId, worktreePath);
  if (expectedResumeSid !== "") expectedResumeSidById.set(ptyId, expectedResumeSid);
}

/** PTY 子プロセス消滅（onExit）時の掃除。removeByPty を通らない稀ケースで
 * expected が残っているなら resume 失敗 sid の掃除機会を逸している — 調査用に stderr に残す */
export function unregisterExit(ptyId: number): void {
  worktreePathById.delete(ptyId);
  sessionIdById.delete(ptyId);
  const stale = expectedResumeSidById.get(ptyId);
  if (stale !== undefined) {
    expectedResumeSidById.delete(ptyId);
    console.error(
      `[PtySessions] exit: dropped expected resume sid=${stale} without removeByPty for pty=${ptyId}`,
    );
  }
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

/** session-start hook 着弾時 / removeByPty 経路で expected sid を読み出して消費する。
 * SessionStart 着弾時に「必ず消費」することで、removeByPty 経路の残存判定が
 * 「SessionStart 一度も不達」と意味的に等価になる（Swift consumeExpectedResumeSid と同契約） */
export function consumeExpectedResumeSid(ptyId: number): string {
  const sid = expectedResumeSidById.get(ptyId) ?? "";
  expectedResumeSidById.delete(ptyId);
  return sid;
}

/** removeByPty から呼ぶ。worktreePath / sessionId の紐付けを両方クリアし、late
 * session-start hook を worktreePath 空ガードで弾けるようにする。expectedResumeSid は
 * 触らない（lifecycle は consume 経路に限定し、resume 失敗 sid を silent に握り潰す
 * 経路を作らない） */
export function clearAssociations(ptyId: number): void {
  worktreePathById.delete(ptyId);
  sessionIdById.delete(ptyId);
  explicitlyRemovedPtyIds.add(ptyId);
}

export function wasExplicitlyRemoved(ptyId: number): boolean {
  return explicitlyRemovedPtyIds.has(ptyId);
}
