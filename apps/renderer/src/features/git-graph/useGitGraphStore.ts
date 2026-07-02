import type { GitCommit } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { useRepoStore } from "../../shared/repo";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import { buildRangeHashes } from "./rangeHashes";

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
  truncatedAbove: false,
};

export const useGitGraphStore = defineStore("gitGraph", () => {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();

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

  /** HEAD ref を持つ commit の hash。loadLog 完了前は undefined */
  const headHash = computed(() => commits.value.find((c) => c.refs.includes("HEAD"))?.hash);

  /**
   * active worktree が指すローカルブランチ名。`git worktree list --porcelain` 由来の
   * `WorktreeEntry.branch` (repoStore SSOT) を読む。
   *
   * 戻り値:
   * - 通常: branch 名 (例: `feat/foo`)
   * - detached HEAD / dir 不在 / 未取得時: undefined
   *
   * branch rename は `branchChange` push 起点の worktree list 再 fetch で追従する。rename 直後の
   * 短い window で stale な値を返しうる (next refetch まで)。PR diff toggle の auto-off 経路が
   * stale 由来の PR 引き当て失敗を救う設計。
   */
  const currentBranch = computed<string | undefined>(() => {
    const dir = worktreeStore.dir;
    if (dir === undefined) return undefined;
    const repo = repoStore.findRepoOwning(dir);
    const wt = repo?.worktrees.find((w) => w.path === dir);
    if (wt === undefined || wt.branch === "") return undefined;
    return wt.branch;
  });

  /** git-graph で working tree 以外の commit が選択されているか (filer の snapshot mode 判定の SSOT) */
  const isSnapshotMode = computed(() => selectedHash.value !== UNCOMMITTED_HASH);

  /** range 選択モードか */
  const isRangeMode = computed(() => compareHash.value !== null);

  /** 範囲選択の片端が Working Tree か */
  const includesWorkingTree = computed(
    () => selectedHash.value === UNCOMMITTED_HASH || compareHash.value === UNCOMMITTED_HASH,
  );

  /** 非 Working Tree 側 endpoint の hash (両端 WT のときは null) */
  const otherEndpointHash = computed(() =>
    selectedHash.value === UNCOMMITTED_HASH ? compareHash.value : selectedHash.value,
  );

  /**
   * Working Tree のみとして処理すべきか。
   *
   * 「Working Tree と HEAD を選んだが、HEAD が表示順で最上位ではない」ケースに限定する。
   * origin/main 等が HEAD より進行していて、Working Tree と HEAD の間に他枝の
   * commit が挟まっている状態。範囲を素直に解釈すると挟まる commit まで含めてしまうので、
   * uncommitted changes のみに倒す。
   *
   * HEAD が表示順で最上位 (commits[0]) の通常ケース (Working Tree → HEAD で間に他 commit
   * なし) では false を返し、range として処理する (HEAD コミット差分 + uncommitted changes
   * を一括表示するため)。
   */
  const workingTreeOnly = computed(() => {
    if (!isRangeMode.value || !includesWorkingTree.value) return false;
    const other = otherEndpointHash.value;
    if (other === null || other !== headHash.value) return false;
    const headIdx = hashToIndex.value.get(other);
    return headIdx !== undefined && headIdx > 0;
  });

  /**
   * 範囲選択時の対象 commit hash 列。newer から first-parent walk で組み立てる。
   * 範囲モードでないときは null。workingTreeOnly のときは空配列 (uncommitted のみとして扱う)。
   * `commits` ロード途中で endpoint が解決できないときは空配列。
   */
  const rangeHashes = computed<string[] | null>(() => {
    const cmp = compareHash.value;
    if (cmp === null) return null;
    if (workingTreeOnly.value) return [];
    return buildRangeHashes(
      selectedHash.value,
      cmp,
      hashToIndex.value,
      commits.value,
      UNCOMMITTED_HASH,
    );
  });

  /**
   * dot 強調用 first-parent walk 結果の Set。範囲モードのみ意味を持つ (単一選択は null)。
   *
   * `rangeHashes` の同期 derived。元実装の「ChangesPane が RPC fetch のついでに書き込む」
   * 経路を廃し、git-graph store 内で `selectedHash` / `compareHash` / `commits` から
   * 同期的に算出する。cross-store 書き込みは不要。
   */
  const activeCommitHashes = computed<Set<string> | null>(() => {
    const hashes = rangeHashes.value;
    if (hashes === null) return null;
    return new Set(hashes);
  });

  /**
   * 選択中のコミット配列（CommitDetailPane が参照する diff 対象 commit 列）。
   *
   * - 単一選択: そのコミット 1 つ
   * - 範囲選択: first-parent walk で得た実 diff 対象のみ (Working Tree 端を含めば先頭に
   *   uncommittedCommit を挿入)。off-branch の commit は除外する
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

  /**
   * Filer / Changes の右クリックメニューで copy する commit hash の SSOT。
   *
   * - range mode (compareHash 非 null): undefined。複数 commit にまたがる diff / snapshot を
   *   単一 hash で代表すると user に誤解 (「この hash 時点」) を与えるため
   * - 単一 commit (UNCOMMITTED_HASH 以外): その hash
   * - working tree (UNCOMMITTED_HASH 単独): undefined
   *
   * Filer の snapshot tree 表示用 hash (`FilerPane.snapshotHash` = `selectedHash` で range mode
   * でも commit hash を生かす) とは別概念。tree 表示は selectedHash 1 つに倒して見せる必要が
   * あるが、copy 経路の「現在 user が見ているデータ全体を 1 hash で代表する」semantics は
   * range mode で成立しないため undefined に倒す。
   */
  const contextMenuHash = computed<string | undefined>(() => {
    if (isRangeMode.value) return undefined;
    if (selectedHash.value === UNCOMMITTED_HASH) return undefined;
    return selectedHash.value;
  });

  /**
   * 範囲選択の min/max インデックス。compareHash が null なら undefined。
   * UNCOMMITTED_HASH は layout.nodes に含まれないため -1 として扱う。
   */
  const rangeIndices = computed<{ min: number; max: number } | undefined>(() => {
    if (compareHash.value === null) return undefined;
    const map = hashToIndex.value;
    const selectedIdx = selectedHash.value === UNCOMMITTED_HASH ? -1 : map.get(selectedHash.value);
    const compareIdx = compareHash.value === UNCOMMITTED_HASH ? -1 : map.get(compareHash.value);
    if (selectedIdx === undefined || compareIdx === undefined) return undefined;
    return { min: Math.min(selectedIdx, compareIdx), max: Math.max(selectedIdx, compareIdx) };
  });

  /** 範囲選択の両端の内側 (端点そのものは含まない) にあるか */
  function isInRange(hash: string): boolean {
    const range = rangeIndices.value;
    if (range === undefined) return false;
    const idx = hashToIndex.value.get(hash);
    if (idx === undefined) return false;
    return idx > range.min && idx < range.max;
  }

  /**
   * 行の青背景ハイライト対象か (単一選択 / 範囲選択の visual range)。
   * 「ユーザーが選んだ範囲そのもの」を表し、実 diff 対象を示す `isActiveDot` とは別軸。
   */
  function isSelectedRow(hash: string): boolean {
    if (compareHash.value === null) return hash === selectedHash.value;
    return hash === selectedHash.value || hash === compareHash.value || isInRange(hash);
  }

  /**
   * dot を branch color で塗って強調する対象か。単一選択時は選択 commit、範囲選択時は
   * first-parent walk の実 diff 対象 (activeCommitHashes)。
   */
  function isActiveDot(hash: string): boolean {
    if (compareHash.value === null) return hash === selectedHash.value;
    return activeCommitHashes.value?.has(hash) ?? false;
  }

  /**
   * 「HEAD をビューポート中央にスクロールせよ」という要求 signal。data 取得側が token を進め、
   * scroll DOM を持つ描画側が watch して実行する。両者を直接呼ばず signal 1 本で疎結合にする。
   */
  const scrollToHeadToken = ref(0);
  function requestScrollToHead() {
    scrollToHeadToken.value++;
  }

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
    headHash,
    currentBranch,
    isSnapshotMode,
    isRangeMode,
    includesWorkingTree,
    otherEndpointHash,
    workingTreeOnly,
    rangeHashes,
    activeCommitHashes,
    contextMenuHash,
    isSelectedRow,
    isActiveDot,
    scrollToHeadToken,
    requestScrollToHead,
    select,
    selectCompare,
    resetSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitGraphStore, import.meta.hot));
}
