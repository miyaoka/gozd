/** Unix 秒を「3d ago」「45m ago」のような相対時刻文字列に整形する。
 *
 * `unixSec <= 0` (= 取得失敗 / 未コミット行 etc) は空文字を返す。呼び出し側で
 * 「データ無し」と区別するために `?? ""` のような fallback は使わず、関数仕様として固定。
 *
 * y / mo / d / h / m / s の閾値は概算 (30 日 = 1 mo 等)。月跨ぎの厳密性は不要な
 * UI 表示用途のみで使う想定。 */
export function formatRelativeTime(unixSec: number): string {
  if (unixSec <= 0) return "";
  const diffSec = Math.floor(Date.now() / 1000) - unixSec;
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / 86400 / 30)}mo ago`;
  return `${Math.floor(diffSec / 86400 / 365)}y ago`;
}

/** Unix 秒を locale 依存の絶対時刻文字列に整形する。
 *
 * `unixSec <= 0` は空文字。`title` 属性の hover-tooltip 用途を想定。 */
export function formatAbsoluteTime(unixSec: number): string {
  if (unixSec <= 0) return "";
  return new Date(unixSec * 1000).toLocaleString();
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** ms 経過時間を短縮表記で返す。task サイドバーのような限られた幅の UI で使う。
 *
 * `formatRelativeTime` との違い:
 *   - 入力: ms × 2 引数 (from, now) — `Date.now()` 直接依存を避けてテスト可能性を高める
 *   - 出力: `now` / `Nm` / `Nh` / `Nd` (`ago` サフィックスなし、s / mo / y 単位なし)
 *
 * UI 表示用途。月跨ぎなど厳密性が必要なケースには使わない。 */
export function formatShortAge(from: number, now: number): string {
  const elapsed = now - from;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}
