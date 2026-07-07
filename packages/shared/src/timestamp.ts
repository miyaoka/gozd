/** worktree の leaf / branch 名に使うタイムスタンプ (YYYYMMDD_HHMMSS 形式)。
 * renderer (新規 worktree 作成) と electron main (revive の branch 衝突 fallback) の両方が使う。
 * 純 TS で完結するため `@gozd/shared` に SSOT を置き、両ランタイムから import する。 */
export function generateTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}
