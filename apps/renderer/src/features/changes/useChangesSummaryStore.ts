import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * Changes summary view（全変更を縦並びで diff 表示するモード）の有効/無効。
 *
 * `usePreviewStore.openSummary` / `toggleSummary` および `usePreviewStore.close` の invariant
 * 経由で操作するのが通常経路で、enabled と popover 開閉のペア遷移はそちらが担う。本 store は
 * state ref と単義 op (enable / disable) を提供するだけで、popover 状態も dir 変化も知らない。
 *
 * `disable()` は「summary を抜けて単一ファイル表示にフォールバック (popover は維持)」の
 * 意図でも使う。ファイル行クリックで `PreviewPane` の watch / `usePreviewStore.requestSelect`
 * が呼ぶ。close 連動が必要な場合は `usePreviewStore.close` の invariant に乗る。
 *
 * dir 切替時の disable は `usePreviewStore` 内部の dir watch (`close()` invariant 経由) が
 * `flush: 'sync'` で同 tick に処理する。本 store 側に dir watch を持たないことで、
 * 「dir 切替で summary を disable する」決定の SSOT を preview close 経路に集約している。
 */
export const useChangesSummaryStore = defineStore("changes-summary", () => {
  const enabled = ref(false);

  function enable() {
    enabled.value = true;
  }

  function disable() {
    enabled.value = false;
  }

  return { enabled, enable, disable };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesSummaryStore, import.meta.hot));
}
