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
 * - 失敗はトーストで通知（CLAUDE.md 規律）。silent drop は禁止
 * - 新規 watch 開始後に `fsWatchReady` を発射して、購読側に 1 度だけ再同期させる
 *   （watch 起動往復中の取りこぼし救済）
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watchEffect } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { dispatchMessage } from "../../shared/rpc";
import { rpcFsUnwatch, rpcFsWatch } from "./rpc";

export function useFsWatchSync() {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** 現在 native 側で watch 中だと local に把握している dir の集合。
   * 差分計算の baseline で、 rpcFsWatch / rpcFsUnwatch の発射対象を絞るために使う。
   * native 側 `FSWatchRegistry.entries` とは独立に持つが、native 側は idempotent なので
   * ズレても correctness は保たれる。 */
  const watchedDirs = new Set<string>();

  function collectTargetDirs(): Set<string> {
    const dirs = new Set<string>();
    for (const rootDir of repoStore.dirOrder) {
      const repo = repoStore.repos[rootDir];
      if (repo === undefined) continue;
      if (!repo.isGitRepo) {
        // 非 git project は worktrees を持たないので rootDir 自身を watch する。
        dirs.add(repo.rootDir);
        continue;
      }
      for (const wt of repo.worktrees) {
        dirs.add(wt.path);
      }
    }
    return dirs;
  }

  async function syncWatches() {
    const next = collectTargetDirs();
    const toUnwatch: string[] = [];
    const toWatch: string[] = [];
    for (const dir of watchedDirs) {
      if (!next.has(dir)) toUnwatch.push(dir);
    }
    for (const dir of next) {
      if (!watchedDirs.has(dir)) toWatch.push(dir);
    }

    for (const dir of toUnwatch) {
      const r = await tryCatch(rpcFsUnwatch({ dir }));
      if (!r.ok) {
        notify.error("Failed to stop FS watch", r.error);
      }
      // 失敗してもローカル set からは外す。native 側 entry が残っても次回の watch で
      // idempotent に re-entry するため、長期的な乖離にはならない。
      watchedDirs.delete(dir);
    }
    for (const dir of toWatch) {
      const r = await tryCatch(rpcFsWatch({ dir }));
      if (!r.ok) {
        notify.error("Failed to start FS watch", r.error);
        continue;
      }
      watchedDirs.add(dir);
    }

    if (toWatch.length > 0) {
      // watch 起動往復中に発生した FS / refs 変化の救済として、購読側に 1 度だけ
      // 再同期を促す。payload を持たない契約（dir は購読側が `worktreeStore.dir` を
      // 都度読む）。
      dispatchMessage("fsWatchReady", {});
    }
  }

  watchEffect(() => {
    // `repoStore.dirOrder` / `repoStore.repos[rootDir]` / 各 repo の worktrees 配列を
    // reactive 読みすることで、worktree 集合の変化で再 run される。実 RPC は async で
    // 走るが、並列実行になっても native 側 / collectTargetDirs / watchedDirs の更新は
    // 順序に依存しない（idempotent）。
    void syncWatches();
  });

  onUnmounted(() => {
    for (const dir of watchedDirs) {
      void tryCatch(rpcFsUnwatch({ dir }));
    }
    watchedDirs.clear();
  });
}
