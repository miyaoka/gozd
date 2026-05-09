/**
 * native の `notify` push を購読し、トーストとして表示する。
 *
 * shared/rpc と shared/notification の橋渡し。shared 間の依存は禁じられているため、
 * 上位層（layout feature）でこの bridge を組む。
 */
import { onMounted, onUnmounted } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";

interface NotifyPayload {
  type: "error" | "info";
  source: string;
  message: string;
  detail: string;
}

export function useNotifySubscription() {
  const notify = useNotificationStore();

  let dispose: (() => void) | undefined;
  onMounted(() => {
    dispose = onMessage<NotifyPayload>("notify", ({ type, source, message, detail }) => {
      const fn = type === "error" ? notify.error : notify.info;
      fn(`[${source}] ${message}`, detail);
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
