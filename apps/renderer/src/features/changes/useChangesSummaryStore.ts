import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * Changes summary view（全変更を縦並びで diff 表示するモード）の有効/無効。
 *
 * ChangesPane の View all ボタンが toggle し、PreviewPane が enabled を購読して
 * 単一ファイル表示と summary 表示を切り替える。selectPath で個別ファイルを選んだら
 * disable される (= 単一ファイル表示に戻る)。
 */
export const useChangesSummaryStore = defineStore("changes-summary", () => {
  const enabled = ref(false);

  function toggle() {
    enabled.value = !enabled.value;
  }

  function enable() {
    enabled.value = true;
  }

  function disable() {
    enabled.value = false;
  }

  return { enabled, toggle, enable, disable };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesSummaryStore, import.meta.hot));
}
