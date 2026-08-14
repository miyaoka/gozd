/**
 * タイトルバーの 1 日進捗バー（`DayProgressBar.vue`）の座標計算。
 *
 * バーは常にローカル時刻の 00:00〜24:00 を左端〜右端に写す固定スケールで、
 * 位置は「時刻 → パーセント」の線形写像だけで決まる。
 */

/** バーが表す 1 日の長さ（時間）。バー幅 100% がこの時間に対応する。 */
const HOURS_PER_DAY = 24;

/** 昼帯として塗る範囲。日の出 / 日の入りの実測ではなく、生活時間帯としての固定値。
 * 実測にすると観測地の緯度経度が要り、同じタイムゾーン内でも 1 時間以上ずれる
 * （東京と与那国で日の出 84 分差）。バーは時刻の当たりを付けるための背景であって
 * 天文情報ではないため、場所に依存しない固定値を採る。 */
const DAYTIME_START_HOUR = 6;
const DAYTIME_END_HOUR = 18;

/** 目盛りラベルを出す時刻。両端 (0 / 24) を含むので、バーの全長が読み取れる。 */
export const TICK_HOURS = [0, 6, 12, 18, 24];

/** 目盛りラベルの横方向の寄せ。ラベルは目盛り位置を基準に配置するため、両端だけ
 * バーの内側へ折り返さないと文字がバーからはみ出す。 */
export type TickAlign = "start" | "center" | "end";

const TICK_ALIGN: Record<number, TickAlign> = {
  0: "start",
  [HOURS_PER_DAY]: "end",
};

export function tickAlign(hour: number): TickAlign {
  return TICK_ALIGN[hour] ?? "center";
}

/** ラベルを目盛り位置に対して寄せる transform。`tickAlign` の各値に対応する。 */
const TICK_TRANSFORM: Record<TickAlign, string> = {
  start: "translateX(0)",
  center: "translateX(-50%)",
  end: "translateX(-100%)",
};

export function tickTransform(hour: number): string {
  return TICK_TRANSFORM[tickAlign(hour)];
}

/** ローカル時刻を 0〜24 の小数時間に変換する。日付は捨てて時刻だけを見る。 */
export function hoursOfDay(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** 時刻（時間）をバー上の位置（%）に変換する。 */
export function hourToPercent(hour: number): number {
  return (hour / HOURS_PER_DAY) * 100;
}

/** 帯の種別。 */
export type SegmentKind = "daytime" | "nighttime";

/** バーを構成する帯。0 時から 24 時までを隙間なく覆う。 */
const SEGMENTS: { startHour: number; endHour: number; kind: SegmentKind }[] = [
  { startHour: 0, endHour: DAYTIME_START_HOUR, kind: "nighttime" },
  { startHour: DAYTIME_START_HOUR, endHour: DAYTIME_END_HOUR, kind: "daytime" },
  { startHour: DAYTIME_END_HOUR, endHour: HOURS_PER_DAY, kind: "nighttime" },
];

/** 昼夜の境界に空ける隙間（px）。隣り合う帯を半分ずつ後退させて作る。
 * 帯どうしが直に接すると、彩度の違う 2 色の境目で色が滲んで見える（マッハバンド）。 */
const SEGMENT_GAP_PX = 2;

export interface BarSegment {
  key: string;
  kind: SegmentKind;
  left: string;
  width: string;
}

/** 各帯の位置と幅。時刻は % で、隙間は px で効かせる必要があるため calc で混ぜる
 * （隙間をバー幅に比例させると、狭いウィンドウで隙間が潰れ広い画面で開きすぎる）。
 * バーの両端は隙間を作る相手がいないので後退させない。 */
export function barSegments(): BarSegment[] {
  const half = SEGMENT_GAP_PX / 2;
  return SEGMENTS.map(({ startHour, endHour, kind }) => {
    const leftInset = startHour === 0 ? 0 : half;
    const rightInset = endHour === HOURS_PER_DAY ? 0 : half;
    return {
      key: `${kind}-${startHour}`,
      kind,
      left: `calc(${hourToPercent(startHour)}% + ${leftInset}px)`,
      width: `calc(${hourToPercent(endHour - startHour)}% - ${leftInset + rightInset}px)`,
    };
  });
}

/** 現在時刻の読み上げ / 補助表示用の文字列。バーの目盛りが 0〜24 なので、locale の
 * 12 時間制設定に関わらず 24 時間表記に固定してスケールと一致させる。 */
const CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatClockTime(date: Date): string {
  return CLOCK_FORMATTER.format(date);
}
