import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

export const useGitGraphStore = defineStore("gitGraph", () => {
  /** 選択中のコミットハッシュ。null は未選択 */
  const selectedHash = ref<string | null>(null);
  /** shift+クリックで指定した比較対象のコミットハッシュ。null は単一選択モード */
  const compareHash = ref<string | null>(null);

  function select(hash: string) {
    selectedHash.value = hash;
    compareHash.value = null;
  }

  /** shift+クリックで範囲選択の終点を指定する */
  function selectCompare(hash: string) {
    if (selectedHash.value === null) {
      selectedHash.value = hash;
      return;
    }
    compareHash.value = hash;
  }

  function clearSelection() {
    selectedHash.value = null;
    compareHash.value = null;
  }

  return { selectedHash, compareHash, select, selectCompare, clearSelection };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitGraphStore, import.meta.hot));
}
