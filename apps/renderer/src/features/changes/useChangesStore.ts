import type { GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
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
 * 変更ファイル一覧 (uncommitted / commit / range) の SSOT。
 *
 * ChangesPane の樹状ビューと ChangesSummaryView の縦並び diff ビューが同じソースを参照する。
 * RPC fetch を store に閉じ込めることで、2 つのビューが同時に画面に出ても fetch を二重発火しない。
 *
 * 選択モード判定 (uncommitted / range / single commit) / `workingTreeOnly` / `rangeHashes` の
 * derived 値はすべて `useGitGraphStore` 側で同期 computed として算出されており、当 store は
 * それらを **読むだけ** で git-graph 側の state を書き換えない (cross-store write の禁止)。
 */
export const useChangesStore = defineStore("changes", () => {
  const worktreeStore = useWorktreeStore();
  const gitGraphStore = useGitGraphStore();
  const gitStatusStore = useGitStatusStore();
  const notification = useNotificationStore();

  /** コミット選択時に取得した変更ファイル一覧 */
  const commitFiles = ref<GitFileChange[]>([]);
  const loading = ref(false);
  /** in-flight リクエストの無効化用シーケンス番号 */
  let requestSeq = 0;

  const isUncommittedMode = computed(() => gitGraphStore.selectedHash === UNCOMMITTED_HASH);

  const fileChanges = computed<GitFileChange[]>(() => {
    if ((isUncommittedMode.value && !gitGraphStore.isRangeMode) || gitGraphStore.workingTreeOnly) {
      return gitStatusToFileChanges(gitStatusStore.gitStatuses);
    }
    return commitFiles.value;
  });

  // コミット選択 / commits 配列が変わったら変更ファイルを取得
  watch(
    () =>
      [
        gitGraphStore.selectedHash,
        gitGraphStore.compareHash,
        gitGraphStore.commits,
        gitGraphStore.rangeHashes,
        gitGraphStore.workingTreeOnly,
        gitGraphStore.includesWorkingTree,
        gitGraphStore.headHash,
      ] as const,
    async ([
      hash,
      compareHash,
      ,
      rangeHashesValue,
      workingTreeOnlyValue,
      includesWorkingTreeValue,
      headHashValue,
    ]) => {
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

      // 範囲モード
      if (compareHash !== null) {
        if (workingTreeOnlyValue) {
          commitFiles.value = [];
          loading.value = false;
          return;
        }

        // Working Tree 端を含むのに HEAD が見つからない: walk 起点が決まらないので空に倒す
        if (includesWorkingTreeValue && headHashValue === undefined) {
          commitFiles.value = [];
          loading.value = false;
          return;
        }

        const rangeHashes = rangeHashesValue ?? [];
        // rangeHashes 空: range 解決失敗 (commits ロード途中など)。単一 commit 経路に落とさず空で確定
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
            includeWorkingTree: includesWorkingTreeValue,
          }),
        );
        if (seq !== requestSeq) return;
        if (!result.ok) {
          notification.error("Failed to load changed files for range", result.error);
          commitFiles.value = [];
          loading.value = false;
          return;
        }
        commitFiles.value = result.value.changes;
        loading.value = false;
        return;
      }

      // 単一 commit
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
      if (!result.ok) {
        notification.error("Failed to load changed files for commit", result.error);
        commitFiles.value = [];
        loading.value = false;
        return;
      }
      commitFiles.value = result.value.changes;
      loading.value = false;
    },
    { immediate: true },
  );

  return { fileChanges, loading };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesStore, import.meta.hot));
}
