import type { GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import {
  rpcGitCommitFiles,
  rpcGitPrDiffFiles,
  useGitGraphStore,
  usePrDiffToggleStore,
} from "../git-graph";
import {
  UNCOMMITTED_HASH,
  resolveGitChangeKind,
  useGitStatusStore,
  useWorktreeStore,
} from "../worktree";
import type { GitChangeKind } from "../worktree";
import { buildChangesTree, flattenChangesTree } from "./changesTree";
import type { ChangesTreeNode } from "./changesTree";

const TYPE_MAP: Record<GitChangeKind, GitFileChange["type"]> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
};

export function gitStatusToFileChanges(
  statuses: Record<string, string>,
  renameOldPaths: Record<string, string>,
): GitFileChange[] {
  return Object.entries(statuses).map(([filePath, statusCode]) => {
    const kind = resolveGitChangeKind(statusCode);
    return {
      // rename は statuses のキー (新パス) と HEAD 側のパスが異なる。旧パスを欠くと
      // summary view が `git show HEAD:<新パス>` を引いて全行追加の diff に倒れる。
      oldFilePath: renameOldPaths[filePath] ?? filePath,
      newFilePath: filePath,
      type: TYPE_MAP[kind],
    };
  });
}

/**
 * Changes パネルが取得すべきファイル一覧の「ソース」を表す discriminated union。
 *
 * 既存実装で if 列に積まれていた分岐 (prDiff / workingTree / range / commit) を 1 個の
 * source.kind に統一する SSOT。`fileChanges` computed も watcher も全てこの値だけを見て
 * 分岐する。新モード追加は `kind` の追加 1 か所で済む。
 */
type ChangesSource =
  | { kind: "none" }
  | { kind: "prDiff"; dir: string; baseOid: string }
  | { kind: "workingTree"; dir: string }
  | {
      kind: "range";
      dir: string;
      hash: string;
      compareHash: string;
      rangeHashes: string[];
      includeWorkingTree: boolean;
    }
  | { kind: "commit"; dir: string; hash: string };

/**
 * 変更ファイル一覧 (uncommitted / commit / range / pr-diff) の SSOT。
 *
 * ChangesPane の樹状ビューと ChangesSummaryView の縦並び diff ビューが同じソースを参照する。
 * RPC fetch を store に閉じ込めることで、2 つのビューが同時に画面に出ても fetch を二重発火しない。
 *
 * 選択モード判定は `source` computed に集約され、`fileChanges` / watcher 共に `source.kind` を
 * 唯一の分岐軸として動く。git-graph 側 state は読むだけで書かない (cross-store write の禁止)。
 */
export const useChangesStore = defineStore("changes", () => {
  const worktreeStore = useWorktreeStore();
  const gitGraphStore = useGitGraphStore();
  const gitStatusStore = useGitStatusStore();
  const prDiffToggle = usePrDiffToggleStore();
  const notification = useNotificationStore();

  /** fetch 結果。`source.kind` ごとに該当する場合のみ参照される */
  const fetchedFiles = ref<GitFileChange[]>([]);
  const loading = ref(false);
  /** in-flight リクエストの無効化用シーケンス番号。source / dir が変わるたび increment */
  let requestSeq = 0;

  /** untracked ファイル (git status `?? `) を `U` として GitFileChange に写像する。
   *
   * PR diff モード / range mode + Working Tree 端では `--diff-filter=AMDR` で除外される
   * untracked file を merge して、「いま push したら base に入るもの (commit 済み + add 済み +
   * untracked)」を網羅する。Claude が新規ファイルを書いて未 add の状態を pre-push review する
   * gozd の primary use case と整合。 */
  const untrackedFiles = computed<GitFileChange[]>(() =>
    Object.entries(gitStatusStore.gitStatuses)
      .filter(([_, code]) => resolveGitChangeKind(code) === "untracked")
      .map(([path]) => ({ oldFilePath: path, newFilePath: path, type: "U" as const })),
  );

  /** `git diff --diff-filter=AMDR` 由来の tracked 変更に untracked を append する untracked merge の
   * SSOT。PR diff モードと range mode + Working Tree 端が共有する。dedup は newFilePath key で行う
   * (Swift 側 diff の path 表記と gitStatus の path 表記は同一形式)。 */
  function mergeUntracked(tracked: GitFileChange[]): GitFileChange[] {
    const seen = new Set(tracked.map((c) => c.newFilePath));
    const extras = untrackedFiles.value.filter((c) => !seen.has(c.newFilePath));
    return [...tracked, ...extras];
  }

  /**
   * 現在の Changes パネルが取得すべきソース。優先順位:
   *
   * - PR diff toggle ON かつ base OID 解決済み → `prDiff`
   * - graph 側 selection が Working Tree のみ (range mode でない) または `workingTreeOnly` → `workingTree`
   *   (status から直接取得、fetch 不要)
   * - range mode → `range`
   * - 単一 commit 選択 → `commit`
   * - それ以外 (dir 不在 / 起動中) → `none`
   *
   * dir / headHash 等が解決できない不整合は `none` に倒して空表示にする (silent fallback ではなく
   * 明示的に「未確定」とすることで watcher 側の早期 return 経路が一意になる)。
   */
  const source = computed<ChangesSource>(() => {
    const dir = worktreeStore.dir;
    if (dir === undefined) return { kind: "none" };

    // PR diff モード時の表示 OID は `lockedBaseOid` (= enable 時 snapshot された merge-base OID)。
    // live `baseOid` を使うと「base 変更 → 表示が即変化 → auto-off watcher が遅れて発火」の
    // race で 1 tick だけ「auto-off 前の base 変更を反映した diff」が表示される事故が起きる。
    // reachable 判定 / fetch / merge-base 計算は `usePrDiffToggleStore.enable()` 側で済んでいる
    // ため、本 store はその起点 OID をそのまま `rpcGitPrDiffFiles` の baseHash に渡すだけで良い。
    if (prDiffToggle.isOn) {
      const baseOid = prDiffToggle.lockedBaseOid;
      if (baseOid === undefined) return { kind: "none" };
      return { kind: "prDiff", dir, baseOid };
    }

    const hash = gitGraphStore.selectedHash;
    const compareHash = gitGraphStore.compareHash;
    const isUncommittedSingle = hash === UNCOMMITTED_HASH && compareHash === null;

    if (isUncommittedSingle || gitGraphStore.workingTreeOnly) {
      return { kind: "workingTree", dir };
    }

    if (compareHash !== null) {
      const rangeHashes = gitGraphStore.rangeHashes ?? [];
      // rangeHashes 空: 解決失敗 (commits ロード途中など) → 未確定
      if (rangeHashes.length === 0) return { kind: "none" };
      // Working Tree 端を含むのに HEAD が見つからない: walk 起点が決まらない → 未確定
      if (gitGraphStore.includesWorkingTree && gitGraphStore.headHash === undefined) {
        return { kind: "none" };
      }
      return {
        kind: "range",
        dir,
        hash,
        compareHash,
        rangeHashes,
        includeWorkingTree: gitGraphStore.includesWorkingTree,
      };
    }

    return { kind: "commit", dir, hash };
  });

  const fileChanges = computed<GitFileChange[]>(() => {
    const src = source.value;
    if (src.kind === "none") return [];
    if (src.kind === "workingTree") {
      return gitStatusToFileChanges(gitStatusStore.gitStatuses, gitStatusStore.renameOldPaths);
    }
    // PR diff / range mode + Working Tree 端は --diff-filter=AMDR で untracked が除外されるため、
    // untracked merge の SSOT (`mergeUntracked`) を通して「base に入る untracked」を append する。
    if (src.kind === "prDiff") return mergeUntracked(fetchedFiles.value);
    if (src.kind === "range" && src.includeWorkingTree) return mergeUntracked(fetchedFiles.value);
    // range (WT 端なし) / commit はそのまま fetched を返す
    return fetchedFiles.value;
  });

  /**
   * source が変わったら fetch (workingTree / none は fetch 不要なので skip)。
   *
   * 経路ごとの RPC 呼び分け:
   * - prDiff: `rpcGitPrDiffFiles` (Swift 側は tracked AMDR diff のみ。untracked は `fileChanges`
   *   computed が `mergeUntracked` で append する)。base reachable 判定 / fetch / merge-base 計算は
   *   `usePrDiffToggleStore.enable()` が事前に済ませており、`source.baseOid` は merge-base OID。
   * - range / commit: `rpcGitCommitFiles` (既存)
   */
  watch(
    source,
    async (src) => {
      const seq = ++requestSeq;

      if (src.kind === "none" || src.kind === "workingTree") {
        fetchedFiles.value = [];
        loading.value = false;
        return;
      }

      loading.value = true;

      if (src.kind === "prDiff") {
        const result = await tryCatch(rpcGitPrDiffFiles({ dir: src.dir, baseHash: src.baseOid }));
        if (seq !== requestSeq) return;
        if (!result.ok) {
          notification.error("Failed to load PR diff", result.error);
          fetchedFiles.value = [];
          loading.value = false;
          return;
        }
        fetchedFiles.value = result.value.changes;
        loading.value = false;
        return;
      }

      if (src.kind === "range") {
        const result = await tryCatch(
          rpcGitCommitFiles({
            dir: src.dir,
            hash: src.hash,
            compareHash: src.compareHash,
            rangeHashes: src.rangeHashes,
            includeWorkingTree: src.includeWorkingTree,
          }),
        );
        if (seq !== requestSeq) return;
        if (!result.ok) {
          notification.error("Failed to load changed files for range", result.error);
          fetchedFiles.value = [];
          loading.value = false;
          return;
        }
        fetchedFiles.value = result.value.changes;
        loading.value = false;
        return;
      }

      // commit
      const result = await tryCatch(
        rpcGitCommitFiles({
          dir: src.dir,
          hash: src.hash,
          compareHash: "",
          rangeHashes: [],
          includeWorkingTree: false,
        }),
      );
      if (seq !== requestSeq) return;
      if (!result.ok) {
        notification.error("Failed to load changed files for commit", result.error);
        fetchedFiles.value = [];
        loading.value = false;
        return;
      }
      fetchedFiles.value = result.value.changes;
      loading.value = false;
    },
    { immediate: true },
  );

  /**
   * GitHub PR 風の chain 圧縮済みディレクトリツリー。`fileChanges` の派生 SSOT。
   *
   * ChangesPane (tree view) と ChangesSummaryView (縦並び view) の両方が購読する。tree 構築を
   * 個々の view 側で行うと、`fileChanges` 1 更新あたり `buildChangesTree` が view 数ぶん独立に走り、
   * 不正 path で throw する経路に到達した場合の `notification.error` も view ごとに二重発火するため、
   * 派生先を store の同期 computed に閉じる。
   *
   * `buildChangesTree` は不正 path (空 segment / 重複 / file⇔folder 衝突) で throw する契約。失敗時は
   * Result を経由して空配列に倒し、純粋な値だけ返す。トースト通知は同一 store 内の `watch(treeResult.ok)`
   * で副作用として 1 回だけ発射する (computed が副作用を持たない Vue 規律と整合)。
   */
  const treeResult = computed(() => tryCatch(() => buildChangesTree(fileChanges.value)));
  const tree = computed<ChangesTreeNode[]>(() =>
    treeResult.value.ok ? treeResult.value.value : [],
  );

  /**
   * ChangesPane のツリー描画と同順にフラット化したファイル一覧 (depth-first、folder 先 + localeCompare、
   * chain 圧縮込み)。ChangesSummaryView が縦並び diff の表示順として購読する。また Pane / Summary 両者で
   * 件数表示・空判定・View all の disabled 制御もこの 1 つの computed を購読軸に揃える。
   *
   * ChangesPane の `collapsedFolders` は描画上の折りたたみ状態であって `tree` 自体には影響しないため、
   * Summary は collapsed 状態に依存せず全件を展開した順序になる (View all の意味論と整合)。
   *
   * tree 構築失敗時は `[]` にフォールバックする。`fileChanges` を返すと「描画は空 ([]) なのに件数表示は
   * 元の N 件」「View all は disabled にならない」など view 内 / view 間で件数と表示が分裂するため、
   * 失敗時は描画ソースと件数判定ソースを構造的に揃える ([] にしておけば Pane: "No changes" + tree 空、
   * Summary: "No changes" で両者一致)。失敗自体の観察可能性は `watch(treeResult.ok)` 側のトーストで担保。
   */
  const orderedFileChanges = computed<GitFileChange[]>(() =>
    treeResult.value.ok ? flattenChangesTree(treeResult.value.value) : [],
  );

  // 監視 source は `treeResult.value.ok` (boolean) に限定する。computed の memo により同一 fileChanges
  // 入力に対して Result identity も維持されるが、source を `ok` flag に絞ることで「失敗状態への遷移」
  // 1 回だけ発火する契約が型レベルで明示される (成功 → 成功の同 identity 再評価で誤発火しない保険)。
  watch(
    () => treeResult.value.ok,
    (ok) => {
      if (ok) return;
      const result = treeResult.value;
      if (result.ok) return;
      notification.error("Failed to build changes tree", result.error);
    },
  );

  return { loading, tree, orderedFileChanges };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesStore, import.meta.hot));
}
