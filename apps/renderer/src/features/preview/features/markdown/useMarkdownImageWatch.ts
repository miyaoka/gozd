import type { FsChangeAbsolutePayload, FsChangePayload } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watch, type Ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { onMessage } from "../../../../shared/rpc";
import { relDirOf, rpcFsUnwatchFileAbsolute, rpcFsWatchFileAbsolute } from "../../../filer";
import type { PreviewServingTarget } from "../../previewServingTarget";

/** 固定 message + 詳細を cause に分離し、画像違いでトーストが累積しないようにする */
const WATCH_FAILED_MESSAGE = "Could not watch images in markdown preview";
const UNWATCH_FAILED_MESSAGE = "Could not release image watchers in markdown preview";

const NO_PATHS: ReadonlySet<string> = new Set();

/**
 * markdown が描画した画像ファイルの変更を受けて `onChange` を呼ぶ。
 *
 * - worktree 内の markdown: worktree 全体の監視（`fsChange`）が届くので、画像の親 dir で絞る
 * - worktree 外の markdown: `fsChange` が届かないため、表示している画像ごとに単一ファイルの
 *   監視を張る（本体の preview が worktree 外のファイルを表示中だけ監視するのと同じ形）
 */
export function useMarkdownImageWatch(
  target: () => PreviewServingTarget | undefined,
  imagePaths: Ref<ReadonlySet<string>>,
  onChange: () => void,
): void {
  const notification = useNotificationStore();

  onUnmounted(
    onMessage<FsChangePayload>("fsChange", ({ dir, relDir }) => {
      const current = target();
      if (current?.scope !== "worktree" || dir !== current.root) return;
      for (const path of imagePaths.value) {
        if (relDirOf(path.slice(current.root.length + 1)) === relDir) {
          onChange();
          return;
        }
      }
    }),
  );

  /** 単一ファイルの監視を張っている画像の絶対パス */
  const watched = new Set<string>();

  onUnmounted(
    onMessage<FsChangeAbsolutePayload>("fsChangeAbsolute", ({ path }) => {
      if (watched.has(path)) onChange();
    }),
  );

  function startWatch(path: string) {
    watched.add(path);
    void tryCatch(rpcFsWatchFileAbsolute({ absolutePath: path })).then((result) => {
      // 監視できないと画像の変更が表示に反映されず、古い画像のままだと気づけない
      if (!result.ok) {
        notification.error(
          WATCH_FAILED_MESSAGE,
          new Error(`path=${path}`, { cause: result.error }),
        );
      }
    });
  }

  function stopWatch(path: string) {
    watched.delete(path);
    void tryCatch(rpcFsUnwatchFileAbsolute({ absolutePath: path })).then((result) => {
      // 解放の失敗は watcher のリーク（表示は正常に動く）なので info で通知する
      if (!result.ok) {
        notification.info(
          UNWATCH_FAILED_MESSAGE,
          new Error(`path=${path}`, { cause: result.error }),
        );
      }
    });
  }

  watch(
    () => (target()?.scope === "directory" ? imagePaths.value : NO_PATHS),
    (paths) => {
      for (const path of watched) {
        if (!paths.has(path)) stopWatch(path);
      }
      for (const path of paths) {
        if (!watched.has(path)) startWatch(path);
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    for (const path of watched) stopWatch(path);
  });
}
