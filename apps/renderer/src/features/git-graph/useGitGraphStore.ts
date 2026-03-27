import type { GitCommit } from "@gozd/rpc";
import { UNCOMMITTED_HASH } from "@gozd/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

/** Working Tree 用の仮想コミット。CommitDetailPane で "Uncommitted Changes" 表示に使用 */
const uncommittedCommit: GitCommit = {
  hash: UNCOMMITTED_HASH,
  shortHash: "*",
  parents: [],
  author: "",
  date: 0,
  message: "Uncommitted Changes",
  body: "",
  refs: [],
};

export const useGitGraphStore = defineStore("gitGraph", () => {
  /** 選択中のコミットハッシュ。未選択時は UNCOMMITTED_HASH にフォールバック */
  const selectedHash = ref<string>(UNCOMMITTED_HASH);
  /** shift+クリックで指定した比較対象のコミットハッシュ。null は単一選択モード */
  const compareHash = ref<string | null>(null);
  /** ユーザー操作による選択のバージョン。select / selectCompare でのみインクリメント */
  const selectionVersion = ref(0);

  /** git log で取得したコミット一覧。GitGraphPane が loadLog() で更新し、ChangesPane が選択状態経由で参照する */
  const commits = ref<GitCommit[]>([]);

  /** hash → コミットインデックスのルックアップ */
  const hashToIndex = computed(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < commits.value.length; i++) {
      map.set(commits.value[i].hash, i);
    }
    return map;
  });

  /** 選択中のコミット配列。範囲選択時は selected〜compare 間の全コミットを返す */
  const selectedCommits = computed<GitCommit[]>(() => {
    const map = hashToIndex.value;

    if (compareHash.value === null) {
      if (selectedHash.value === UNCOMMITTED_HASH) return [uncommittedCommit];
      const idx = map.get(selectedHash.value);
      return idx !== undefined ? [commits.value[idx]] : [];
    }

    // UNCOMMITTED_HASH を -1 として扱い、範囲の始点に含める
    const selectedIdx = selectedHash.value === UNCOMMITTED_HASH ? -1 : map.get(selectedHash.value);
    const compareIdx = compareHash.value === UNCOMMITTED_HASH ? -1 : map.get(compareHash.value);
    if (selectedIdx === undefined || compareIdx === undefined) return [];

    const minIdx = Math.min(selectedIdx, compareIdx);
    const maxIdx = Math.max(selectedIdx, compareIdx);
    const result = commits.value.slice(Math.max(0, minIdx), maxIdx + 1);
    if (minIdx === -1) result.unshift(uncommittedCommit);
    return result;
  });

  function select(hash: string) {
    selectedHash.value = hash;
    compareHash.value = null;
    selectionVersion.value++;
  }

  /** shift+クリックで範囲選択の終点を指定する */
  function selectCompare(hash: string) {
    compareHash.value = hash;
    selectionVersion.value++;
  }

  function resetSelection() {
    selectedHash.value = UNCOMMITTED_HASH;
    compareHash.value = null;
  }

  return {
    selectedHash,
    compareHash,
    selectionVersion,
    commits,
    selectedCommits,
    hashToIndex,
    select,
    selectCompare,
    resetSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitGraphStore, import.meta.hot));
}
