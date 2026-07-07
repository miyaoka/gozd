/**
 * 非同期取得したリストを選ぶ picker の状態機械を作る module singleton factory。
 * PR / Issue picker のように「gh の取得を待ってから一覧を選ぶ」構造は同型なので、
 * loading → ready の 2 状態と open/setResult/hide/accept をここに集約する。
 *
 * 取得完了前に open() で loading を可視化し、完了後 setResult() で埋める設計により、
 * gh GraphQL の待ち時間中の無反応と、0 件時の silent 終了の両方を防ぐ。
 */

import { ref, type Ref } from "vue";

export type ListPickerStatus = "loading" | "ready";

export function createListPicker<T>() {
  const items = ref([]) as Ref<T[]>;
  const viewer = ref("");
  const status = ref<ListPickerStatus>("loading");
  const showSignal = ref(0);
  const hideSignal = ref(0);
  let acceptCallback: ((item: T) => void) | undefined;

  /** loading 状態で dialog を即時表示する。fetch 前に呼ぶ。 */
  function open() {
    items.value = [];
    viewer.value = "";
    acceptCallback = undefined;
    status.value = "loading";
    showSignal.value++;
  }

  /**
   * fetch 完了後に items を埋めて ready へ遷移する。items が空なら empty state を表示する。
   * accept callback はここで束ねる: 選択は ready 遷移後にしか起きず、
   * callback が参照する派生データ (worktree list 等) もこの時点で確定しているため。
   */
  function setResult(nextItems: T[], viewerLogin: string, onAccept: (item: T) => void) {
    items.value = nextItems;
    viewer.value = viewerLogin;
    acceptCallback = onAccept;
    status.value = "ready";
  }

  /** fetch 失敗時に loading dialog を閉じる (エラーは呼び出し側が toast で通知する)。 */
  function hide() {
    hideSignal.value++;
  }

  function accept(item: T) {
    acceptCallback?.(item);
  }

  return { items, viewer, status, showSignal, hideSignal, open, setResult, hide, accept };
}
