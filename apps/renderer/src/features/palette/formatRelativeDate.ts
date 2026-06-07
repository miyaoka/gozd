/** 相対日時の表示情報 */
interface DateDisplay {
  text: string;
  color: string;
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

/** ISO 日時文字列を相対日時テキストと色に変換する */
export function formatRelativeDate(isoDate: string): DateDisplay {
  const date = new Date(isoDate);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);

  if (minutes < MINUTES_PER_HOUR) {
    return { text: `${minutes}m ago`, color: "text-success-text" };
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return { text: `${hours}hr ago`, color: "text-warning-text" };
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days < DAYS_PER_WEEK) {
    return { text: `${days}d ago`, color: "text-warning-strong-text" };
  }
  if (days < DAYS_PER_MONTH) {
    const weeks = Math.floor(days / DAYS_PER_WEEK);
    return { text: `${weeks}w ago`, color: "text-foreground-low" };
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { text: `${y}/${m}/${d}`, color: "text-foreground-low" };
}
