/**
 * 軸の見出しに出す件数の表示を決める。
 *
 * 見出しの数字は 2 つの事実を運びうる — 取得が上限で切れているか、絞り込みで減っているか。
 * `docs/git.md` の「表示」節がこの 2 つを同じ表記で出すことを禁じているため、判定をここに閉じて
 * 機械で確かめられるようにする（SFC の computed に埋めると組合せを踏むテストが書けない）。
 */

/** 件数表示の入力。取得結果と絞り込みの状態から表示が決まる */
export interface MyWorkCountInput {
  /** 未読だけに絞っているか */
  unreadOnly: boolean;
  /** 実際に描く行数 */
  visibleCount: number;
  /** 取得できた行数（絞り込み前） */
  fetchedCount: number;
  /** 検索条件に一致する総件数。取得上限で切れていると fetchedCount を上回る */
  totalCount: number;
}

export interface MyWorkCountDisplay {
  label: string;
  title: string;
}

/** 取得上限で切れているか。絞り込みは取得済みの中でしか効かないため、判定に visibleCount を使わない */
export function isMyWorkTruncated(input: MyWorkCountInput): boolean {
  return input.totalCount > input.fetchedCount;
}

export function myWorkCountDisplay(input: MyWorkCountInput): MyWorkCountDisplay {
  const { unreadOnly, visibleCount, fetchedCount, totalCount } = input;
  const truncated = isMyWorkTruncated(input);

  if (unreadOnly) {
    // 絞り込み中は表示件数だけを出す。`N / M` は「上限で切れている」ことを表す語彙として
    // 使われており、同じ表記に「絞り込んだ」の意味を重ねると読み分けられなくなる
    return {
      label: `${visibleCount}`,
      title: truncated
        ? `${visibleCount} unread among the ${fetchedCount} most recently updated of ${totalCount}`
        : `${visibleCount} unread of ${totalCount}`,
    };
  }

  return truncated
    ? {
        label: `${fetchedCount} / ${totalCount}`,
        title: `Showing the ${fetchedCount} most recently updated of ${totalCount}`,
      }
    : { label: `${totalCount}`, title: `${totalCount} total` };
}

/** 行が 1 つも無いときの理由。絞り込み中の空は「この軸に何も無い」ではなく「未読が無い」 */
export function myWorkEmptyMessage(unreadOnly: boolean): string {
  return unreadOnly ? "No unread items" : "Nothing here";
}
