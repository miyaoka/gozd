/** 直近に返した秒精度の基底値。同一秒内の連続呼び出しを検知する per-process 状態 */
let lastBase = "";
/** 同一秒内の連番。基底値が変わるたびに 1 へ戻る */
let seq = 1;

/** worktree の leaf / branch 名に使うタイムスタンプ (YYYYMMDD_HHMMSS 形式)。
 * renderer (新規 worktree 作成) と electron main (revive の branch 衝突 fallback) の両方が使う。
 * 純 TS で完結するため `@gozd/shared` に SSOT を置き、両ランタイムから import する。
 *
 * 返り値はプロセス内で一意。名前は git の worktree dir / branch の一意名として使われるため、
 * 秒精度のままだと連続作成 (picker の Shift 連続選択等) で同一秒の 2 呼び出しが同名になり
 * `git worktree add` が衝突する。同一秒内の 2 回目以降は `_2`, `_3`... の連番 suffix を付けて
 * 生成時点で衝突を不能にする (呼び出し側での in-flight 検知 + リトライ導線を不要にする)。 */
export function generateTimestamp(): string {
  const now = new Date();
  const base = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  if (base === lastBase) {
    seq += 1;
    return `${base}_${seq}`;
  }
  lastBase = base;
  seq = 1;
  return base;
}
