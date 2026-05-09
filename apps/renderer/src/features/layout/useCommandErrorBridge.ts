/**
 * command 実行エラーをトースト通知に流す。
 *
 * shared/command と shared/notification の橋渡し。shared 間の依存は禁じられているため、
 * 上位層（layout feature）でこの bridge を組む。
 */
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";

export function useCommandErrorBridge() {
  const notify = useNotificationStore();
  const { setErrorHandler } = useCommandRegistry();
  setErrorHandler(notify.error);
}
