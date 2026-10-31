import type { FsChangeAbsolutePayload } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watch, type Ref } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { onMessage, rpcFsExistsAbsolute } from "../../../../shared/rpc";
import { rpcFsUnwatchFileAbsolute, rpcFsWatchFileAbsolute } from "../../../filer";

/** 固定 message + 詳細を cause に分離し、可変の詳細はトーストの詳細パネルで読ませる */
const WATCH_FAILED_MESSAGE = "Could not watch images in markdown preview";
const UNWATCH_FAILED_MESSAGE = "Could not release image watchers in markdown preview";

function dirOf(absPath: string): string {
  return absPath.substring(0, absPath.lastIndexOf("/")) || "/";
}

/**
 * markdown が描画した画像ファイルの変更を受けて `onChange` を呼ぶ。
 *
 * 画像ごとに単一ファイルの監視を張る。worktree 全体の監視（`fsChange`）はディレクトリ単位でしか
 * 届かず、画像と同じ dir の別ファイル（md 自身を含む）の変更でも描き直してしまう。また undock した
 * preview は worktree を閉じても生き続けるため、worktree の監視に頼ると追従が黙って止まる。
 */
export function useMarkdownImageWatch(
  imagePaths: Ref<ReadonlySet<string>>,
  onChange: () => void,
): void {
  const notification = useNotificationStore();

  /**
   * 単一ファイルの監視を張っている（張ろうとしている）画像の絶対パス → その試行の識別子。
   * 監視の応答を待つ間に外して張り直すことがあるため、失敗の後始末は自分の試行のときだけ行う
   */
  const watched = new Map<string, symbol>();

  onUnmounted(
    onMessage<FsChangeAbsolutePayload>("fsChangeAbsolute", ({ path }) => {
      if (watched.has(path)) onChange();
    }),
  );

  /**
   * 監視の失敗を通知する。親 dir が無いのは画像そのものが無い状態（壊れた参照）で、表示上も
   * 画像が出ないだけなので通知しない。それ以外は、変更が反映されないまま古い画像が残るため通知する
   */
  async function reportWatchFailure(path: string, error: Error) {
    const exists = await tryCatch(rpcFsExistsAbsolute({ absolutePaths: [dirOf(path)] }));
    if (exists.ok && exists.value.exists[0] === false) return;
    notification.error(WATCH_FAILED_MESSAGE, new Error(`path=${path}`, { cause: error }));
  }

  function startWatch(path: string) {
    const attempt = Symbol(path);
    watched.set(path, attempt);
    void tryCatch(rpcFsWatchFileAbsolute({ absolutePath: path })).then((result) => {
      if (result.ok) return;
      // 外された・張り直された後の失敗は、今の監視とも表示中の画像とも関係しない
      if (watched.get(path) !== attempt) return;
      // 監視できなかったパスは外し、次の描画でもう一度試す
      watched.delete(path);
      void reportWatchFailure(path, result.error);
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
    imagePaths,
    (paths) => {
      for (const path of watched.keys()) {
        if (!paths.has(path)) stopWatch(path);
      }
      for (const path of paths) {
        if (!watched.has(path)) startWatch(path);
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    for (const path of watched.keys()) stopWatch(path);
  });
}
