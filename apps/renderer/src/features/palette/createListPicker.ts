/**
 * 非同期取得したリストを選ぶ picker の状態機械を作る module singleton factory。
 * PR / Issue picker のように「gh の取得を待ってから一覧を選ぶ」構造は同型なので、
 * loading → ready の 2 状態と open/setResult/hide/accept をここに集約する。
 *
 * 取得完了前に open() で loading を可視化し、完了後 setResult() で埋める設計により、
 * gh GraphQL の待ち時間中の無反応と、0 件時の silent 終了の両方を防ぐ。
 *
 * ## ページに分かれて届く母集合
 *
 * 最初のページで setResult() し、続きは表示側が requestMore() で足す。いつ足すかは表示側が
 * 決める（契約は docs/git.md の「PR の取得は問いごとに分ける」）。
 *
 * 取得済み件数と総数 (`totalCount`) を表示側へ渡すのは進捗を示すため。取り切ったかどうかは
 * `hasMore` が持つ。
 *
 * open() は fetch 前に走り setResult()/hide() は fetch 後に走るため、遅れて解決した
 * 取得が「すでに別の open() で開き直された dialog」を上書きしうる (dir 切替を挟んだ
 * stale swap、loading 中の重複起動)。open() が返す generation を setResult()/hide() に
 * 渡し、現在世代と一致するときだけ反映することで stale 応答を無視する。
 */

import type { Ref } from "vue";
import { computed, ref, shallowRef } from "vue";

export type ListPickerStatus = "loading" | "ready";

/** ページ送りの 1 ページ。`done` はこれ以上取りに行かないことを表す（取り切り / 失敗の両方）。 */
export interface ListPickerPage<T> {
  items: T[];
  done: boolean;
}

export function createListPicker<T>() {
  // 型引数を残したまま deep reactive を保つ。素の `ref<T[]>` は値の型が `UnwrapRefSimple<T>[]`
  // になり、T が未確定のあいだ T[] を代入できない。行の書き戻し（`existingTask` の後追い更新）を
  // 一覧へ反映させるため deep reactive 自体は要るので、shallowRef ではなく型注釈で解く。
  const items = ref([]) as Ref<T[]>;
  const viewer = ref("");
  const status = ref<ListPickerStatus>("loading");
  /** 続きのページを取得中か。表示側はこれで「まだ全部ではない」ことを出す。 */
  const loadingMore = ref(false);
  /** 次のページを取る手段。取り切った / ページ送りが無いときは undefined。 */
  const fetchNext = shallowRef<(() => Promise<ListPickerPage<T>>) | undefined>();
  /**
   * まだ取っていないページがあるか。`fetchNext` から導出する。
   *
   * 2 つの ref で別々に持つと、`requestMore` が即 return するのに「まだある」と答える状態を
   * 作れてしまう。表示側は続きの有無を見て再判定を繰り返すため、その不一致は空回りし続ける。
   */
  const hasMore = computed(() => fetchNext.value !== undefined);
  /** 母集合の総数。取得の最初に判明する。0 は「総数を知らない取得」。 */
  const totalCount = ref(0);
  /** この取得がページに分かれていたか。末尾の「終端」表示を出すかの判定に使う。 */
  const pagedOnce = ref(false);
  /** dialog が表示中か。閉じた後も続きを取りに行かないための停止条件。 */
  const showing = ref(false);
  const showSignal = ref(0);
  const hideSignal = ref(0);
  let generation = 0;
  let acceptCallback: ((item: T) => void | Promise<void>) | undefined;

  /** loading 状態で dialog を即時表示する。fetch 前に呼ぶ。返り値の世代を setResult/hide に渡す。 */
  function open(): number {
    generation++;
    items.value = [];
    viewer.value = "";
    acceptCallback = undefined;
    status.value = "loading";
    loadingMore.value = false;
    totalCount.value = 0;
    pagedOnce.value = false;
    fetchNext.value = undefined;
    showing.value = true;
    showSignal.value++;
    return generation;
  }

  /**
   * dialog が閉じたことを記録する。**ページ送りを使う表示側は、閉じる経路すべてから呼ぶ。**
   *
   * `setResult` / `hide` と違い世代を取らない。閉じた通知が「いま表示している dialog のもの」かは
   * **表示側にしか判定できない**（close イベントはタスクとしてキューされるため、閉じた直後に
   * 開き直すと開いた後の dialog へ届く。区別が付くのはその時点の DOM の状態だけで、`open()` の
   * 回数では表せない）。呼ぶかどうかの判定ごと表示側に置く。
   */
  function markClosed() {
    showing.value = false;
  }

  /**
   * fetch 完了後に items を埋めて ready へ遷移する。items が空なら empty state を表示する。
   * accept callback はここで束ねる: 選択は ready 遷移後にしか起きず、
   * callback が参照する派生データ (worktree list 等) もこの時点で確定しているため。
   * gen が現在世代と異なる (別の open() に置き換わった) 応答は stale として捨てる。
   */
  function setResult(
    gen: number,
    nextItems: T[],
    viewerLogin: string,
    onAccept: (item: T) => void | Promise<void>,
  ) {
    if (gen !== generation) return;
    items.value = nextItems;
    viewer.value = viewerLogin;
    acceptCallback = onAccept;
    status.value = "ready";
  }

  /**
   * 母集合の総数を記録する。取得済み件数と並べて「どこまで手元にあるか」を示すために使う。
   *
   * 続きの有無 (`setPageSource`) とは別に持つ。1 ページで収まった取得でも総数は意味を持ち、
   * 「続きがあるか」と「全部で何件か」は別の問いであるため。
   */
  function setTotalCount(gen: number, total: number) {
    if (gen !== generation) return;
    totalCount.value = total;
  }

  /**
   * ページ送りの続きを束ねる。`setResult` と同じ世代で、**続きがあるときだけ**呼ぶ。
   *
   * `next` は取れた項目と**打ち切るかどうか (`done`)** を返す契約。項目と打ち切りを 1 つの値で
   * 兼ねさせない: 最終ページは「項目があり、かつこれで終わり」なので、片方だけでは表せず、
   * 表せないと同じカーソルをもう一度引いて同じページを二重に足す。
   *
   * 失敗も `done: true` で打ち切る。通知は呼び出し側が出す（ここは状態機械であって取得の
   * 事情を知らない）。
   */
  function setPageSource(gen: number, next: () => Promise<ListPickerPage<T>>) {
    if (gen !== generation) return;
    fetchNext.value = next;
    pagedOnce.value = true;
  }

  /**
   * 続きを 1 ページ取って末尾へ足す。**表示側が一覧の末尾へ到達したときに呼ぶ。**
   *
   * 多重発火はここで潰す。スクロールは 1 回の到達で何度も発火するので、判定を呼び出し側へ
   * 出すと同じページを何度も取りに行く形が容易に作れてしまう。
   *
   * 並べ替えはしない。ページは取得順のまま届き、その順序が一覧の順序そのものであるため。
   */
  async function requestMore(): Promise<void> {
    const next = fetchNext.value;
    if (!showing.value || loadingMore.value || next === undefined) return;
    const gen = generation;
    loadingMore.value = true;
    try {
      const page = await next();
      // 開き直された / 閉じられた世代の結果は捨てる
      if (gen !== generation) return;
      if (page.items.length > 0) items.value = [...items.value, ...page.items];
      if (page.done) fetchNext.value = undefined;
    } finally {
      if (gen === generation) loadingMore.value = false;
    }
  }

  /**
   * fetch 失敗時に loading dialog を閉じる。作用したかを返す。
   * gen が現在世代と異なる場合は、別の open() で開き直した dialog を巻き添えに
   * 閉じないよう no-op にして false を返す。呼び出し側はこの返り値で対の error
   * toast を束ね、置き換わった (superseded) 世代の失敗トーストを抑止する
   * (toast も現在世代の起動だけが駆動すべき UI 効果のため)。
   */
  function hide(gen: number): boolean {
    if (gen !== generation) return false;
    showing.value = false;
    hideSignal.value++;
    return true;
  }

  /** 選択 item に callback を適用する。返り値の promise は callback の完了（成功 / 失敗を
   * 問わず）を表し、dialog が「連続選択（Shift 選択）で完了まで追加の accept をブロックする」
   * ために使う。sync callback / 未束縛（loading 中 / open で破棄済み）は即 resolve。 */
  function accept(item: T): Promise<void> {
    return Promise.resolve(acceptCallback?.(item));
  }

  return {
    items,
    viewer,
    status,
    loadingMore,
    hasMore,
    totalCount,
    pagedOnce,
    showSignal,
    hideSignal,
    open,
    setResult,
    setTotalCount,
    setPageSource,
    requestMore,
    markClosed,
    hide,
    accept,
  };
}
