/**
 * 一覧の下端に出す件数と、行が 1 つも無いときの文言を決める。
 *
 * どちらも「取得の進捗」と「絞り込みの結果」という別々の事実を運びうる。混ぜて 1 つの数や
 * 1 つの文言にすると、読み手が「まだ取っていない」と「存在しない」を区別できなくなる。
 * 判定をここに閉じて、組合せを機械で確かめられるようにする。
 */

/** 一覧の状態。取得の進捗と絞り込みの状態から表示が決まる */
export interface PrPickerListInput {
  /** 絞り込みが掛かっているか */
  isFiltered: boolean;
  /** 絞り込み後に実際に描く行数 */
  shownCount: number;
  /** 取得できた行数（絞り込み前） */
  loadedCount: number;
  /** repo の open PR 総数。fork を除外する前の数なので loadedCount が届かないことがある */
  totalCount: number;
  /** 未取得のページが残っているか */
  hasMore: boolean;
}

/**
 * 取得済み / 総数。絞り込み中はその結果件数を先頭に足す。
 *
 * 絞り込みが無いとき shown は loaded と必ず一致するので出さない。同じ値を 2 度並べても読み手が
 * 得るものが無く、違いのある場面での差分が目立たなくなる。
 *
 * 総数を取り切りの判定に使わない。`total` は fork PR を除外する前の数で、loaded は除外した後の
 * 数なので、取り切っても届かないことがある。取り切ったかどうかは一覧の末尾表示が示す。
 *
 * 総数が取れていない場合は何も出さない。進捗の分母が無い状態で loaded だけを出すと、それが
 * 全件なのか途中なのかを読み分けられない。
 */
export function prPickerCountsLabel(input: PrPickerListInput): string {
  const { isFiltered, shownCount, loadedCount, totalCount } = input;
  if (totalCount === 0) return "";
  const loaded = `${loadedCount} loaded / ${totalCount} total`;
  return isFiltered ? `${shownCount} shown / ${loaded}` : loaded;
}

/**
 * 行が 1 つも無いときの文言。
 *
 * **未取得が残っている間は「無い」と言い切らない。**絞り込みは取得済みの分にしか掛からないので、
 * 0 件は「存在しない」ではなく「まだ取っていない」かもしれない。絞り込みの有無でも意味が違い、
 * 絞り込み無しの 0 件は「この repo に open PR が無い」を指す。
 */
export function prPickerEmptyMessage(
  input: Pick<PrPickerListInput, "isFiltered" | "hasMore">,
): string {
  const { isFiltered, hasMore } = input;
  if (isFiltered) {
    return hasMore ? "No match in the loaded pull requests" : "No matching pull requests";
  }
  return hasMore ? "No pull requests in the loaded pages" : "No open pull requests";
}
