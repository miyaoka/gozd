import { tryCatch } from "@gozd/shared";
import { watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcWindowSetTitleContext } from "./rpc";
import { useTitleContext } from "./useTitleContext";

/**
 * タイトル文字列を native window title（Mission Control / Cmd+Tab 表示）へ push する。
 * ウィンドウ内の表示は TitleBar.vue が同じ useTitleContext を直接 render する。
 */
export function useTitleContextSync(): void {
  const notify = useNotificationStore();
  const title = useTitleContext();

  // computed は primitive string なので `===` 比較で「値が変わったときだけ」発火する
  watch(
    title,
    async (text) => {
      // active な repo がまだ無い起動直後は push しない。main 側は空文字で "gozd" に
      // フォールバックするが、空 push のラウンドトリップ自体を省く
      if (text === "") return;
      const result = await tryCatch(rpcWindowSetTitleContext({ title: text }));
      if (!result.ok) {
        notify.error("Failed to sync window title context", result.error);
      }
    },
    { immediate: true },
  );
}
