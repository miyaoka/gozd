/**
 * 選択中 dir に応じて native 側の FSWatchRegistry の対象 dir を切り替える app-scope な watcher。
 *
 * 旧 dir は unwatch、新 dir は watch することで、サーバー側の FSWatcher を選択中 worktree に
 * 同期させる。fsChange / gitStatusChange 等の push event がここを起点に届くようになる。
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useWorktreeStore } from "../worktree";
import { rpcFsUnwatch, rpcFsWatch } from "./rpc";

export function useFsWatchSync() {
  const worktreeStore = useWorktreeStore();
  const notify = useNotificationStore();

  watch(
    () => worktreeStore.dir,
    async (newDir, oldDir) => {
      if (oldDir !== undefined && oldDir !== newDir) {
        await tryCatch(rpcFsUnwatch({ dir: oldDir }));
      }
      if (newDir !== undefined && newDir !== oldDir) {
        const result = await tryCatch(rpcFsWatch({ dir: newDir }));
        if (!result.ok) {
          notify.error("Failed to start FS watch", result.error);
        }
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    if (worktreeStore.dir !== undefined) {
      void tryCatch(rpcFsUnwatch({ dir: worktreeStore.dir }));
    }
  });
}
