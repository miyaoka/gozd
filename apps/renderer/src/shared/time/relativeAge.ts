/**
 * 一覧の行に出す「最後に動いたのはいつか」の表示。テキストと鮮度色を組で返す。
 *
 * 色を時刻整形と同じ場所に置くのは、**帯の境界と表記の切り替え点が同じ経過時間で決まる**
 * ため。別々の場所に置くと、片方の閾値だけ動かして色と表記がずれた状態を作れる。
 *
 * 30 日を超えたら相対表記をやめて絶対日付にする。「4mo ago」まで薄まると、経過の長さより
 * 「いつだったか」の方が知りたい情報になるため。
 *
 * `unixSec <= 0`（日付不明 / 取得失敗）は空文字。呼び出し側に fallback を書かせないための
 * 関数仕様で、`formatRelativeTime` と同じ契約。
 *
 * 未来時刻（時計ずれ）は `formatRelativeTime` が `in 3m` に倒すため、負の経過が文字列へ
 * 漏れない。
 */
import { formatCompactDate, formatRelativeTime } from "./relativeTime";

const HOUR_SEC = 3600;
const DAY_SEC = 24 * HOUR_SEC;
const WEEK_SEC = 7 * DAY_SEC;
const MONTH_SEC = 30 * DAY_SEC;

/** 経過が短いほど強い色を当てる。最初に一致した帯を採る（境界は未満）。 */
const AGE_BANDS = [
  { withinSec: HOUR_SEC, color: "text-success-text" },
  { withinSec: DAY_SEC, color: "text-warning-text" },
  { withinSec: WEEK_SEC, color: "text-warning-strong-text" },
] as const;

/** どの帯にも入らない古い項目 */
const STALE_COLOR = "text-foreground-low";
/** 日付が分からない項目。テキストが空になるので色は最も弱いものにする */
const UNKNOWN_COLOR = "text-foreground-muted";

export interface RelativeAgeDisplay {
  text: string;
  color: string;
}

export function formatRelativeAge(unixSec: number): RelativeAgeDisplay {
  if (unixSec <= 0) return { text: "", color: UNKNOWN_COLOR };
  const ageSec = Math.floor(Date.now() / 1000) - unixSec;
  return {
    text: ageSec >= MONTH_SEC ? formatCompactDate(unixSec) : formatRelativeTime(unixSec),
    color: AGE_BANDS.find((band) => ageSec < band.withinSec)?.color ?? STALE_COLOR,
  };
}

/** ISO 8601 → Unix 秒。parse できなければ 0（`formatRelativeAge` が「日付不明」に倒す）。 */
export function isoToUnixSec(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}
