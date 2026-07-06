/**
 * Claude が作業中 (working) の pane を閉じる前の確認 state を保持する module singleton。
 *
 * `useSessionLogViewer` と同じく必要最小の値だけ保持する。close 処理そのものは
 * コマンド handler 側の知識（closePane / resetLayout フォールバック）なので、
 * ここは実行するクロージャを預かるだけにして層の知識を持ち込まない。
 */
import { ref } from "vue";

const pendingAction = ref<(() => void) | undefined>(undefined);

export function useClosePaneConfirm() {
  /** 確認を要求する。OK されたら action が実行される */
  function request(action: () => void) {
    pendingAction.value = action;
  }

  /** 確認を取り下げる（Cancel / backdrop / ESC）。close 済みなら no-op */
  function cancel() {
    pendingAction.value = undefined;
  }

  /** OK: 預かった action を実行して確認を畳む */
  function confirm() {
    const action = pendingAction.value;
    pendingAction.value = undefined;
    action?.();
  }

  return { pendingAction, request, cancel, confirm };
}
