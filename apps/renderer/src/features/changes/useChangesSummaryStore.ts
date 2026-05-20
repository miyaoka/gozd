import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { useWorktreeStore } from "../worktree";

/**
 * Changes summary view（全変更を縦並びで diff 表示するモード）の有効/無効。
 *
 * ChangesPane の View all ボタンが toggle し、PreviewPane が enabled を購読して
 * 単一ファイル表示と summary 表示を切り替える。selectPath で個別ファイルを選んだら
 * disable される (= 単一ファイル表示に戻る)。
 *
 * worktree 切替 (dir 変化) でも disable する: `useWorktreeStore` が dir 変化時に
 * `selection = undefined` で filer 選択を clear するのと対称に、summary state も
 * 跨いで残さない。worktree 跨ぎで summary を維持する要件はない。
 */
export const useChangesSummaryStore = defineStore("changes-summary", () => {
  const worktreeStore = useWorktreeStore();
  const enabled = ref(false);

  function toggle() {
    enabled.value = !enabled.value;
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

  return { enabled, toggle, disable };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesSummaryStore, import.meta.hot));
}
