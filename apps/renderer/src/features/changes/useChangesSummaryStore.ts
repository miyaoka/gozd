import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { useWorktreeStore } from "../worktree";

/**
 * Changes summary view（全変更を縦並びで diff 表示するモード）の有効/無効。
 *
 * `usePreviewStore.openSummary` / `closeSummary` / `toggleSummary` 経由で操作するのが
 * 通常経路で、enabled と popover 開閉のペア遷移はそちらが担う。本 store は state ref と
 * 単義 op (enable / disable) を提供するだけで、popover 状態は知らない。
 *
 * `disable()` は「summary を抜けて単一ファイル表示にフォールバック (popover は維持)」の
 * 意図でも使う。ファイル行クリックで `PreviewPane` の watch / `usePreviewStore.requestSelect`
 * が呼ぶ。close 連動が必要な場合は必ず `usePreviewStore.closeSummary` を経由する。
 *
 * worktree 切替 (dir 変化) でも disable する: `useWorktreeStore` が dir 変化時に
 * `selection = undefined` で filer 選択を clear するのと対称に、summary state も
 * 跨いで残さない。worktree 跨ぎで summary を維持する要件はない。
 */
export const useChangesSummaryStore = defineStore("changes-summary", () => {
  const worktreeStore = useWorktreeStore();
  const enabled = ref(false);

  function enable() {
    enabled.value = true;
  }

  function disable() {
    enabled.value = false;
  }

  // dir 変化で summary を clear。Filer 選択 (worktreeStore.selection) の clear と対称。
  // flush: 'sync' で「dir change → 旧 summary を即 disable → 新 dir の changes 計算」の
  // 順序を担保し、新 dir の fileChanges が旧 dir の summary view に紛れ込まないようにする。
  watch(
    () => worktreeStore.dir,
    () => {
      enabled.value = false;
    },
    { flush: "sync" },
  );

  return { enabled, enable, disable };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesSummaryStore, import.meta.hot));
}
