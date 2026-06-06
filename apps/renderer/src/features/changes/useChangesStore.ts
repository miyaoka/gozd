import type { GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import {
  rpcGitCommitFiles,
  rpcGitPrDiffFiles,
  rpcGitRevReachable,
  useGitGraphStore,
  usePrDiffToggleStore,
} from "../git-graph";
import {
  UNCOMMITTED_HASH,
  resolveGitChangeKind,
  useGitStatusStore,
  useRemoteFetchStore,
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
  const fetchStore = useRemoteFetchStore();
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

    // PR diff モード時の表示 OID は `lockedBaseOid` (= enable 時 snapshot)。
    // live `baseOid` を使うと「base 変更 → 表示が即変化 → auto-off watcher が遅れて発火」の
    // race で 1 tick だけ「auto-off 前の base 変更を反映した diff」が表示される事故が起きる。
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
    if (src.kind === "workingTree") return gitStatusToFileChanges(gitStatusStore.gitStatuses);
    // gitPrDiffFiles が Swift 側で untracked merge 済み。renderer 側追加処理は不要。
    if (src.kind === "prDiff") return fetchedFiles.value;
    if (src.kind === "range" && src.includeWorkingTree) {
      // range mode で Working Tree 端を含むときは untracked を append する
      // (--diff-filter=AMDR で除外されるため)。PR diff と同じ untracked 含む semantic に揃える。
      const seen = new Set(fetchedFiles.value.map((c) => c.newFilePath));
      const extras = untrackedFiles.value.filter((c) => !seen.has(c.newFilePath));
      return [...fetchedFiles.value, ...extras];
    }
    // range (WT 端なし) / commit はそのまま fetched を返す
    return fetchedFiles.value;
  });

  /**
   * source が変わったら fetch (workingTree / none は fetch 不要なので skip)。
   *
   * 経路ごとの RPC 呼び分け:
   * - prDiff: `rpcGitPrDiffFiles` (Swift 側で git diff + untracked merge を完結)。
   *   base OID 未 reachable なら `useRemoteFetchStore.requestImmediateFetch` 経由で fetch を要求。
   * - range / commit: `rpcGitCommitFiles` (既存)
   *
   * fetch 経路は `useRemoteFetchStore` の SSOT を共有することで、背景 polling と on-demand 要求の
   * 二重発射を防ぐ。
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
        // base OID が local に reachable かを先に確認。未 fetch なら fetch を要求して reachable
        // 化を待つ。reachable 判定 → fetch 要求 → 再判定 のチェーンは「fetch 失敗以外の理由で
        // 失敗するときは fetch を炊かない」(rate limit / lock 競合 / dir 不正等への耐性) を担保する。
        const reachable = await tryCatch(rpcGitRevReachable({ dir: src.dir, hash: src.baseOid }));
        if (seq !== requestSeq) return;
        if (!reachable.ok) {
          notification.error("Failed to probe PR diff base reachability", reachable.error);
          fetchedFiles.value = [];
          loading.value = false;
          return;
        }
        if (!reachable.value.reachable) {
          const fetched = await fetchStore.requestImmediateFetch(src.dir);
          if (seq !== requestSeq) return;
          if (!fetched) {
            // toggle ON gate (`usePrDiffToggleStore.canEnable`) が成立する時点で「dir は git
            // worktree として repoStore に hydrate 済み + 現在 branch に open PR + baseRefOid 解決済み」
            // の不変条件は満たされている。よって本経路の false は次のいずれかを意味する:
            //   - `runFetch` 内の git fetch RPC 失敗 (network / 認証 / remote 未設定)
            //   - worktree が toggle ON 後に削除される race (`findRepoOwning` undefined)
            // いずれも下層 (`useRemoteFetchStore`) で notify.info が出ているため、本経路で
            // 追加通知は出さない。fileChanges は空に倒し、source watcher が次の reactive 変化
            // (toggle OFF / worktree 切替) で正常状態に戻すのに委ねる。
            fetchedFiles.value = [];
            loading.value = false;
            return;
          }
        }

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

  return { fileChanges, loading };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChangesStore, import.meta.hot));
}
