/**
 * 非同期取得したリストを選ぶ picker の状態機械を作る module singleton factory。
 * PR / Issue picker のように「gh の取得を待ってから一覧を選ぶ」構造は同型なので、
 * loading → ready の 2 状態と open/setResult/hide/accept をここに集約する。
 *
 * 取得完了前に open() で loading を可視化し、完了後 setResult() で埋める設計により、
 * gh GraphQL の待ち時間中の無反応と、0 件時の silent 終了の両方を防ぐ。
 *
 * open() は fetch 前に走り setResult()/hide() は fetch 後に走るため、遅れて解決した
 * 取得が「すでに別の open() で開き直された dialog」を上書きしうる (dir 切替を挟んだ
 * stale swap、loading 中の重複起動)。open() が返す generation を setResult()/hide() に
 * 渡し、現在世代と一致するときだけ反映することで stale 応答を無視する。
 */

import { ref } from "vue";

export type ListPickerStatus = "loading" | "ready";

export function createListPicker<T>() {
  const items = ref<T[]>([]);
  const viewer = ref("");
  const status = ref<ListPickerStatus>("loading");
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
    showSignal.value++;
    return generation;
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
   * fetch 失敗時に loading dialog を閉じる。作用したかを返す。
   * gen が現在世代と異なる場合は、別の open() で開き直した dialog を巻き添えに
   * 閉じないよう no-op にして false を返す。呼び出し側はこの返り値で対の error
   * toast を束ね、置き換わった (superseded) 世代の失敗トーストを抑止する
   * (toast も現在世代の起動だけが駆動すべき UI 効果のため)。
   */
  function hide(gen: number): boolean {
    if (gen !== generation) return false;
    hideSignal.value++;
    return true;
  }

  /** 選択 item に callback を適用する。返り値の promise は callback の完了（成功 / 失敗を
   * 問わず）を表し、dialog が「連続選択（Shift 選択）で完了まで追加の accept をブロックする」
   * ために使う。sync callback / 未束縛（loading 中 / open で破棄済み）は即 resolve。 */
  function accept(item: T): Promise<void> {
    return Promise.resolve(acceptCallback?.(item));
  }

  return { items, viewer, status, showSignal, hideSignal, open, setResult, hide, accept };
}
