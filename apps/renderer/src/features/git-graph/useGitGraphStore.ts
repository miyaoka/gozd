import type { GitCommit } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { UNCOMMITTED_HASH } from "../worktree";

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

  /**
   * 範囲選択時に first-parent walk で得られた実 diff 対象 commit hash の Set。
   * ChangesPane が rpcGitCommitFiles の戻り値から書き込み、GitGraphPane がハイライト判定に使う。
   * null は単一選択 / 未取得状態。
   */
  const activeCommitHashes = ref<Set<string> | null>(null);

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

  /**
   * 選択中のコミット配列。
   *
   * - 単一選択: そのコミット 1 つ
   * - 範囲選択 + activeCommitHashes 取得済み: first-parent walk で得た実 diff 対象のみ。
   *   walk 対象外の別枝コミットは除外する。range 内に UNCOMMITTED_HASH の端点があれば先頭に含める
   * - 範囲選択 + activeCommitHashes 未取得（fetch 中）: range 内の全コミットをフォールバック表示
   */
  const selectedCommits = computed<GitCommit[]>(() => {
    const map = hashToIndex.value;

    if (compareHash.value === null) {
      if (selectedHash.value === UNCOMMITTED_HASH) return [uncommittedCommit];
      const idx = map.get(selectedHash.value);
      return idx !== undefined ? [commits.value[idx]] : [];
    }

    const selectedIdx = selectedHash.value === UNCOMMITTED_HASH ? -1 : map.get(selectedHash.value);
    const compareIdx = compareHash.value === UNCOMMITTED_HASH ? -1 : map.get(compareHash.value);
    if (selectedIdx === undefined || compareIdx === undefined) return [];

    const minIdx = Math.min(selectedIdx, compareIdx);
    const maxIdx = Math.max(selectedIdx, compareIdx);
    const includesUncommitted = minIdx === -1;
    const sliceStart = Math.max(0, minIdx);

    const active = activeCommitHashes.value;
    if (active !== null) {
      const filtered = commits.value
        .slice(sliceStart, maxIdx + 1)
        .filter((c) => active.has(c.hash));
      if (includesUncommitted) filtered.unshift(uncommittedCommit);
      return filtered;
    }

    const result = commits.value.slice(sliceStart, maxIdx + 1);
    if (includesUncommitted) result.unshift(uncommittedCommit);
    return result;
  });

  function select(hash: string) {
    selectedHash.value = hash;
    compareHash.value = null;
    activeCommitHashes.value = null;
    selectionVersion.value++;
  }

  /** shift+クリックで範囲選択の終点を指定する */
  function selectCompare(hash: string) {
    compareHash.value = hash;
    activeCommitHashes.value = null;
    selectionVersion.value++;
  }

  function resetSelection() {
    selectedHash.value = UNCOMMITTED_HASH;
    compareHash.value = null;
    activeCommitHashes.value = null;
  }

  function setActiveCommitHashes(hashes: string[]) {
    activeCommitHashes.value = new Set(hashes);
  }

  return {
    selectedHash,
    compareHash,
    selectionVersion,
    commits,
    selectedCommits,
    hashToIndex,
    activeCommitHashes,
    select,
    selectCompare,
    resetSelection,
    setActiveCommitHashes,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitGraphStore, import.meta.hot));
}
