import type { GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitCommitFiles, useGitGraphStore, usePrDiffToggleStore } from "../git-graph";
import {
  UNCOMMITTED_HASH,
  resolveGitChangeKind,
  rpcGitFetchRemotes,
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
  const prDiffToggle = usePrDiffToggleStore();
  const notification = useNotificationStore();

  /** コミット選択時に取得した変更ファイル一覧 */
  const commitFiles = ref<GitFileChange[]>([]);
  /** PR diff モード (base..working tree) 時の変更ファイル一覧 */
  const prDiffFiles = ref<GitFileChange[]>([]);
  const loading = ref(false);
  /** in-flight リクエストの無効化用シーケンス番号 */
  let requestSeq = 0;

  const isUncommittedMode = computed(() => gitGraphStore.selectedHash === UNCOMMITTED_HASH);

  /** untracked ファイル (git status `?? `) を `U` として GitFileChange に写像する。
   *
   * PR diff モードでは `--diff-filter=AMDR` で除外される untracked file を別途 merge して、
   * 「いま push したら base に入るもの (commit 済み + add 済み + untracked)」を網羅する。
   * Claude が新規ファイルを書いて未 add の状態を pre-push review する gozd の primary use case と整合。 */
  const untrackedFiles = computed<GitFileChange[]>(() =>
    Object.entries(gitStatusStore.gitStatuses)
      .filter(([_, code]) => resolveGitChangeKind(code) === "untracked")
      .map(([path]) => ({ oldFilePath: path, newFilePath: path, type: "U" as const })),
  );

  const fileChanges = computed<GitFileChange[]>(() => {
    if (prDiffToggle.isOn) {
      // PR diff 表示用の commitFiles 結果に untracked を append する。重複は path key で排除する
      // (`prDiffFiles` の path も `untrackedFiles` の path もどちらも worktree 相対の同一表記)。
      const seen = new Set(prDiffFiles.value.map((c) => c.newFilePath));
      const extras = untrackedFiles.value.filter((c) => !seen.has(c.newFilePath));
      return [...prDiffFiles.value, ...extras];
    }
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
            olderIsBase: false,
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
          olderIsBase: false,
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

  /** PR diff モードの fetch。toggle / base OID / HEAD が変化したら base..working tree を取り直す。
   *
   * gitGraphStore の selection 経路 (commitFiles watcher) と独立して動く。toggle ON 中も
   * 通常の commitFiles watcher は変化を検知しなければ動かない (selection は graph 側のまま)。
   *
   * `pr.baseRefOid` が local に reachable でない場合は 1 度だけ `git fetch --all` を自動で発射し、
   * その後 retry する。fetch 失敗時はエラー通知 + prDiffFiles を空に倒す。 */
  let prDiffSeq = 0;
  watch(
    () =>
      [prDiffToggle.isOn, prDiffToggle.baseOid, gitGraphStore.headHash, worktreeStore.dir] as const,
    async ([isOn, baseOid, headHash, dir]) => {
      const seq = ++prDiffSeq;

      if (!isOn || baseOid === undefined || headHash === undefined || dir === undefined) {
        prDiffFiles.value = [];
        return;
      }

      loading.value = true;
      const fetchCommitFiles = () =>
        rpcGitCommitFiles({
          dir,
          hash: UNCOMMITTED_HASH,
          compareHash: baseOid,
          // Swift 側は rangeHashes の先頭 (newer) と末尾 (older) しか見ない。
          // PR diff では newer=HEAD, older=baseOid を渡し、olderIsBase + includeWorkingTree で
          // `git diff <baseOid>` (= base..working tree) を実行させる。
          rangeHashes: [headHash, baseOid],
          includeWorkingTree: true,
          olderIsBase: true,
        });
      let result = await tryCatch(fetchCommitFiles());
      if (seq !== prDiffSeq) return;

      if (!result.ok) {
        // base OID が local に reachable でない可能性 (未 fetch / fork PR で別 remote)。
        // git fetch を 1 度だけ自動発射して retry する。fetch が失敗したら諦めてエラー表示。
        const fetchResult = await tryCatch(rpcGitFetchRemotes({ dir }));
        if (seq !== prDiffSeq) return;
        if (!fetchResult.ok || !fetchResult.value.ok) {
          notification.error(
            "Failed to fetch remotes for PR diff base",
            fetchResult.ok ? undefined : fetchResult.error,
          );
          prDiffFiles.value = [];
          loading.value = false;
          return;
        }
        result = await tryCatch(fetchCommitFiles());
        if (seq !== prDiffSeq) return;
        if (!result.ok) {
          notification.error("Failed to load PR diff", result.error);
          prDiffFiles.value = [];
          loading.value = false;
          return;
        }
      }
      prDiffFiles.value = result.value.changes;
      loading.value = false;
    },
    { immediate: true },
  );

  return { fileChanges, loading };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesStore, import.meta.hot));
}
