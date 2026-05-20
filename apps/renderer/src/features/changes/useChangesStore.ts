import type { GitCommit, GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { rpcGitCommitFiles, useGitGraphStore } from "../git-graph";
import {
  UNCOMMITTED_HASH,
  resolveGitChangeKind,
  useGitStatusStore,
  useWorktreeStore,
} from "../worktree";
import type { GitChangeKind } from "../worktree";

const TYPE_MAP: Record<GitChangeKind, GitFileChange["type"]> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
};

function gitStatusToFileChanges(statuses: Record<string, string>): GitFileChange[] {
  return Object.entries(statuses).map(([filePath, statusCode]) => {
    const kind = resolveGitChangeKind(statusCode);
    return {
      oldFilePath: filePath,
      newFilePath: filePath,
      type: TYPE_MAP[kind],
    };
  });
}

/**
 * 範囲選択時の対象 commit hash 列を組み立てる。
 *
 * 仕様: newer (上端) から `commit.parents[0]` を辿り、older の表示位置に到達したら停止する。
 * 別枝の独立コミット (mergeCommitStreams が date 順で挿入する origin/HEAD 系の commit など)
 * は対象に含まれない。UNCOMMITTED_HASH 端の扱いは ChangesPane 原実装と同じ。
 */
function buildRangeHashes(
  selected: string,
  compare: string,
  hashToIndex: Map<string, number>,
  commits: readonly GitCommit[],
): string[] {
  const sIdx = selected === UNCOMMITTED_HASH ? -1 : (hashToIndex.get(selected) ?? Infinity);
  const cIdx = compare === UNCOMMITTED_HASH ? -1 : (hashToIndex.get(compare) ?? Infinity);

  const newerIsSelected = sIdx <= cIdx;
  const newerRaw = newerIsSelected ? selected : compare;
  const olderIdxRaw = newerIsSelected ? cIdx : sIdx;

  const startHash =
    newerRaw === UNCOMMITTED_HASH
      ? (commits.find((c) => c.refs.includes("HEAD"))?.hash ?? "")
      : newerRaw;
  if (startHash === "") return [];

  const stopIdx = olderIdxRaw < 0 ? Number.POSITIVE_INFINITY : olderIdxRaw;

  const result: string[] = [];
  let currentHash = startHash;
  while (true) {
    const idx = hashToIndex.get(currentHash);
    if (idx === undefined || idx > stopIdx) break;
    const commit = commits[idx];
    result.push(commit.hash);
    if (idx === stopIdx) break;
    const firstParent = commit.parents[0];
    if (firstParent === undefined) break;
    currentHash = firstParent;
  }
  return result;
}

/**
 * 変更ファイル一覧 (uncommitted / commit / range) の SSOT。
 *
 * ChangesPane の樹状ビューと ChangesSummaryView の縦並び diff ビューが同じソースを参照する。
 * RPC fetch と `setActiveCommitHashes` の副作用も含めて store に閉じ込めることで、
 * 2 つのビューが同時に画面に出ても fetch を二重発火しない。
 */
export const useChangesStore = defineStore("changes", () => {
  const worktreeStore = useWorktreeStore();
  const gitGraphStore = useGitGraphStore();
  const gitStatusStore = useGitStatusStore();

  /** コミット選択時に取得した変更ファイル一覧 */
  const commitFiles = ref<GitFileChange[]>([]);
  const loading = ref(false);
  /** in-flight リクエストの無効化用シーケンス番号 */
  let requestSeq = 0;

  const isUncommittedMode = computed(() => gitGraphStore.selectedHash === UNCOMMITTED_HASH);
  const isRangeMode = computed(() => gitGraphStore.compareHash !== null);
  const headHash = computed(() => gitGraphStore.commits.find((c) => c.refs.includes("HEAD"))?.hash);
  const includesWorkingTree = computed(
    () =>
      gitGraphStore.selectedHash === UNCOMMITTED_HASH ||
      gitGraphStore.compareHash === UNCOMMITTED_HASH,
  );
  const otherEndpointHash = computed(() =>
    gitGraphStore.selectedHash === UNCOMMITTED_HASH
      ? gitGraphStore.compareHash
      : gitGraphStore.selectedHash,
  );

  /**
   * Working Tree のみとして処理すべきか。
   * 詳細は ChangesPane (廃止前) の同名 computed コメント参照。
   */
  const workingTreeOnly = computed(() => {
    if (!isRangeMode.value || !includesWorkingTree.value) return false;
    const otherHash = otherEndpointHash.value;
    if (otherHash === null || otherHash !== headHash.value) return false;
    const headIdx = gitGraphStore.hashToIndex.get(otherHash);
    return headIdx !== undefined && headIdx > 0;
  });

  const fileChanges = computed<GitFileChange[]>(() => {
    if ((isUncommittedMode.value && !isRangeMode.value) || workingTreeOnly.value) {
      return gitStatusToFileChanges(gitStatusStore.gitStatuses);
    }
    return commitFiles.value;
  });

  // コミット選択 / commits 配列が変わったら変更ファイルを取得
  watch(
    () => [gitGraphStore.selectedHash, gitGraphStore.compareHash, gitGraphStore.commits] as const,
    async ([hash, compareHash]) => {
      const seq = ++requestSeq;

      if (hash === UNCOMMITTED_HASH && compareHash === null) {
        commitFiles.value = [];
        loading.value = false;
        return;
      }
      const dir = worktreeStore.dir;
      if (dir === undefined) {
        commitFiles.value = [];
        loading.value = false;
        return;
      }

      if (compareHash !== null) {
        if (workingTreeOnly.value) {
          gitGraphStore.setActiveCommitHashes([]);
          commitFiles.value = [];
          loading.value = false;
          return;
        }

        const rangeHashes = buildRangeHashes(
          hash,
          compareHash,
          gitGraphStore.hashToIndex,
          gitGraphStore.commits,
        );
        gitGraphStore.setActiveCommitHashes(rangeHashes);

        if (includesWorkingTree.value && headHash.value === undefined) {
          commitFiles.value = [];
          loading.value = false;
          return;
        }

        if (rangeHashes.length === 0) {
          commitFiles.value = [];
          loading.value = false;
          return;
        }

        loading.value = true;
        const result = await tryCatch(
          rpcGitCommitFiles({
            dir,
            hash,
            compareHash,
            rangeHashes,
            includeWorkingTree: includesWorkingTree.value,
          }),
        );
        if (seq !== requestSeq) return;
        commitFiles.value = result.ok ? result.value.changes : [];
        loading.value = false;
        return;
      }

      loading.value = true;
      const result = await tryCatch(
        rpcGitCommitFiles({
          dir,
          hash,
          compareHash: "",
          rangeHashes: [],
          includeWorkingTree: false,
        }),
      );
      if (seq !== requestSeq) return;
      commitFiles.value = result.ok ? result.value.changes : [];
      loading.value = false;
    },
    { immediate: true },
  );

  return { fileChanges, loading };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesStore, import.meta.hot));
}
