/**
 * 一覧の行に出す「最後に動いたのはいつか」の表示。テキストと鮮度色を組で返す。
 *
 * 色を時刻整形と同じ場所に置くのは、**帯の境界と表記の切り替え点が同じ経過時間で決まる**
 * ため。帯の境界は表示単位の閾値（relativeTime の DAY_SEC / WEEK_SEC）を共有し、
 * 片方の閾値だけ動かして色と表記がずれた状態を構造的に作れないようにする。
 *
 * 4 週間を超えたら相対表記をやめて絶対日付にする。週単位より先まで薄まると、経過の長さより
 * 「いつだったか」の方が知りたい情報になるため。境界が暦月（30 日）でなく 4 週間なのは、
 * 週表記の上限と色帯の境界を一致させるため（30 日にすると 28〜29 日だけ「4w ago」の
 * 半端な隙間ができる。GitHub の relative-time-element も weeks>=4 を月へ繰り上げており、
 * 表示される週数は双方「3w」が最大）。
 *
 * `unixSec <= 0`（日付不明 / 取得失敗）は空文字。呼び出し側に fallback を書かせないための
 * 関数仕様で、`formatRelativeTime` と同じ契約。
 *
 * 未来時刻（時計ずれ）は `formatRelativeTime` が `in 3m` に倒すため、負の経過が文字列へ
 * 漏れない。
 *
 * `nowSec` は既定で現在時刻。帯の境界をテストで踏めるよう注入でき、テキストと色が同じ
 * 時計から導かれることを保証する（片方だけ現在時刻を読むと境界上でずれる）。
 */
import { DAY_SEC, formatCompactDate, formatRelativeTime, WEEK_SEC } from "./relativeTime";

const FOUR_WEEKS_SEC = 4 * WEEK_SEC;

/** 鮮度 4 段階。最初に一致した帯を採る（境界は未満）。
 * 帯名は表示単位（hour = 秒・分・時間表記、day = 日、week = 週、date = 絶対日付）。
 * 各帯の意味は main.css の age-* token 定義コメント、値と知覚検証は
 * `@gozd/design-tokens` の generator が SSOT。 */
const AGE_BANDS = [
  { withinSec: DAY_SEC, color: "text-age-hour" },
  { withinSec: WEEK_SEC, color: "text-age-day" },
  { withinSec: FOUR_WEEKS_SEC, color: "text-age-week" },
] as const;

/** どの帯にも入らない古い項目。絶対日付への表記切り替えと同じ FOUR_WEEKS_SEC 境界で落ちる */
const DATE_COLOR = "text-age-date";
/** 日付が分からない項目。テキストが空になるので色は最も弱いものにする */
const UNKNOWN_COLOR = "text-foreground-muted";

export interface RelativeAgeDisplay {
  text: string;
  color: string;
}

export function formatRelativeAge(
  unixSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): RelativeAgeDisplay {
  if (unixSec <= 0) return { text: "", color: UNKNOWN_COLOR };
  const ageSec = nowSec - unixSec;
  return {
    text:
      ageSec >= FOUR_WEEKS_SEC ? formatCompactDate(unixSec) : formatRelativeTime(unixSec, nowSec),
    color: AGE_BANDS.find((band) => ageSec < band.withinSec)?.color ?? DATE_COLOR,
  };
}

/** ISO 8601 → Unix 秒。parse できなければ 0（`formatRelativeAge` が「日付不明」に倒す）。 */
export function isoToUnixSec(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}
