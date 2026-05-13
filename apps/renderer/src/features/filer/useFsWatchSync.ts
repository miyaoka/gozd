/**
 * 選択中 dir に応じて native 側の FSWatchRegistry の対象 dir を切り替える app-scope な watcher。
 *
 * 旧 dir は unwatch、新 dir は watch することで、サーバー側の FSWatcher を選択中 worktree に
 * 同期させる。fsChange / gitStatusChange 等の push event がここを起点に届くようになる。
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { dispatchMessage } from "../../shared/rpc";
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
          return;
        }
        // rpcFsWatch の往復遅延中に発生した FS / refs 変化を救済する再同期トリガー。
        // FSEvents は `kFSEventStreamEventIdSinceNow` 起点で動くため、watch 起動前後の
        // 数十〜数百 ms 窓で起きた変更は配信されない。subscriber 側で `loadLog` /
        // `fetchOwnerOfActive` 等を一度だけ再発射してもらう。
        dispatchMessage("fsWatchReady", { dir: newDir });
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
