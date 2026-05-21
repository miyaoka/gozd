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
