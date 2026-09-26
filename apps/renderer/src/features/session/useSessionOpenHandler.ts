/**
 * main の `sessionOpen` push を購読し、`gozd session open` で指定されたセッションを開く。
 *
 * 開き方はサイドバーのセッション行のクリックと同じ（`openSession`）。作業ディレクトリが
 * gozd に登録された worktree / project でなければ開けないため、通知して終える。
 */
import type { SessionOpenPayload } from "@gozd/rpc";
import { onMounted, onUnmounted } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { openSession } from "./openSession";

export function useSessionOpenHandler() {
  const notifications = useNotificationStore();
  const repoStore = useRepoStore();

  let dispose: (() => void) | undefined;
  onMounted(() => {
    dispose = onMessage<SessionOpenPayload>("sessionOpen", ({ sessionId, dir }) => {
      if (repoStore.findRepoOwning(dir) === undefined) {
        notifications.error(`Cannot open session ${sessionId}: ${dir} is not open in gozd`);
        return;
      }
      openSession(dir, sessionId);
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
