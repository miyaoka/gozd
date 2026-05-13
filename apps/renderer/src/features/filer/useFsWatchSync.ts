/**
 * gozd が開いている全 repo / 全 worktree の dir を native 側 `FSWatchRegistry` に同期して
 * watch させる app-scope な watcher。
 *
 * 設計判断:
 *
 * - 単一 active worktree だけを watch する旧設計は、別 repo / 別 worktree で起きた
 *   commit / rename / push を取りこぼす。gozd は「window 内マルチ repo + マルチ worktree」
 *   が機能要件なので、watch も全 worktree を均等に対象とする
 * - `repoStore.repos[*].worktrees` の集合変化（追加 / 削除）を `watchEffect` で追い、
 *   diff を取って `rpcFsWatch` / `rpcFsUnwatch` を発射する
 * - 非 git project（`isGitRepo === false`）は rootDir そのものを watch（FS 変化のみ）
 * - 失敗はトーストで通知（CLAUDE.md 規律）。複数同時失敗は集約 1 件にする
 * - 新規 watch 開始後に `fsWatchReady` を発射して、購読側に 1 度だけ再同期させる
 * - **並列実行を generation で serialize する**: `watchEffect` は依存変更で再 run するが
 *   前回の async コールバック完了を待たない。前回が `watchedDirs` を更新する前に次回が
 *   走ると、削除済み worktree の watch が永続的に残るレースが起きる。前回完了まで次回を
 *   coalesce することで `watchedDirs` の整合性を保つ
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watchEffect } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { dispatchMessage } from "../../shared/rpc";
import { type RepoStoreForTargetDirs } from "./collectTargetDirs";
import { rpcFsUnwatchAll, rpcFsWatch, rpcFsUnwatch } from "./rpc";
import { runOneSyncPass } from "./runOneSyncPass";
import { runSerializedSync, type SerializeState } from "./runSerializedSync";

export function useFsWatchSync() {
  const repoStore: RepoStoreForTargetDirs = useRepoStore();
  const notify = useNotificationStore();

  /** 現在 native 側で watch 中だと local に把握している dir の集合。
   * 差分計算の baseline で、 `rpcFsWatch` / `rpcFsUnwatch` の発射対象を絞るために使う。 */
  const watchedDirs = new Set<string>();

  /** `syncWatches` の serialize 用 state。`runSerializedSync` に渡す mutex 兼 coalesce フラグ。
   * 実体ロジックは `runSerializedSync.ts` 側の pure helper に切り出し、test で race coalesce
   * 挙動を直接検証している。 */
  const serializeState: SerializeState = { running: false, pending: false };

  async function syncWatches(): Promise<void> {
    await runSerializedSync(serializeState, () =>
      runOneSyncPass({
        repoStore,
        watchedDirs,
        fsWatch: rpcFsWatch,
        fsUnwatch: rpcFsUnwatch,
        notify,
        dispatchReady: () => dispatchMessage("fsWatchReady", {}),
      }),
    );
  }

  watchEffect(() => {
    // `repoStore.dirOrder` / `repoStore.repos[rootDir]` / 各 repo の worktrees 配列を
    // reactive 読みすることで、worktree 集合の変化で再 run される。実 RPC は async で
    // 走るが serialize されており、複数 trigger は 1 回の追加 pass に畳まれる。
    void syncWatches();
  });

  onUnmounted(() => {
    // 1 回の RPC で全 entry を一括破棄する。N 個の `rpcFsUnwatch` を並列発射する
    // 旧設計は失敗を観察可能性なく捨てる構造だったので、`/fs/unwatchAll` に集約。
    // 失敗時は `notify.error` で観察可能性を残す（アプリ終了 race で見えない場合も
    // store 内の console.error が devtools に残る）。
    void tryCatch(rpcFsUnwatchAll({})).then((r) => {
      if (!r.ok) {
        notify.error("Failed to cleanup FS watches", r.error);
      }
    });
    watchedDirs.clear();
  });
}
