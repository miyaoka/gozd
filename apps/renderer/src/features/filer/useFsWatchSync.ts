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
import { collectTargetDirs, type RepoStoreForTargetDirs } from "./collectTargetDirs";
import { rpcFsUnwatch, rpcFsWatch } from "./rpc";

export function useFsWatchSync() {
  const repoStore: RepoStoreForTargetDirs = useRepoStore();
  const notify = useNotificationStore();

  /** 現在 native 側で watch 中だと local に把握している dir の集合。
   * 差分計算の baseline で、 `rpcFsWatch` / `rpcFsUnwatch` の発射対象を絞るために使う。 */
  const watchedDirs = new Set<string>();

  /** `syncWatches` の serialize 用 mutex 兼 coalesce フラグ。
   * - `running`: 現在 in-flight な `syncWatches` があるか
   * - `pending`: in-flight 中に新しい dependency 変化が来たか
   *   in-flight 終了後に pending を消化して 1 回だけ追加実行する（多重 trigger を畳む） */
  let running = false;
  let pending = false;

  async function syncWatches(): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await runOneSyncPass();
      } while (pending);
    } finally {
      running = false;
    }
  }

  async function runOneSyncPass(): Promise<void> {
    const next = collectTargetDirs(repoStore);
    const toUnwatch: string[] = [];
    const toWatch: string[] = [];
    for (const dir of watchedDirs) {
      if (!next.has(dir)) toUnwatch.push(dir);
    }
    for (const dir of next) {
      if (!watchedDirs.has(dir)) toWatch.push(dir);
    }

    const failures: Array<{ kind: "watch" | "unwatch"; dir: string; error: unknown }> = [];

    for (const dir of toUnwatch) {
      const r = await tryCatch(rpcFsUnwatch({ dir }));
      if (!r.ok) {
        failures.push({ kind: "unwatch", dir, error: r.error });
      }
      // 失敗してもローカル set からは外す。native 側 watch は「既存 entry があれば破棄して
      // 再構築」する設計なので、ローカル set と native 側で乖離しても次回の `rpcFsWatch`
      // で永続的不整合は解消される。
      watchedDirs.delete(dir);
    }
    for (const dir of toWatch) {
      const r = await tryCatch(rpcFsWatch({ dir }));
      if (!r.ok) {
        failures.push({ kind: "watch", dir, error: r.error });
        continue;
      }
      watchedDirs.add(dir);
    }

    if (failures.length > 0) {
      // batch 単位で 1 件に集約する。1 ターンで N 個失敗したときにトースト N 個出すのは
      // UX 上 noisy で、全体像も見失う。集約することで「何件、どの種類、どの dir」を
      // 1 件の cause に折り畳む。
      const summary = failures.map((f) => `${f.kind}:${f.dir}`).join(", ");
      const aggregate = new Error(`FS watch sync had ${failures.length} failure(s): ${summary}`);
      // 最初の error を cause として stack を保持する
      const [first] = failures;
      const cause = first?.error;
      notify.error(`Failed to sync FS watches (${failures.length})`, cause ?? aggregate);
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
    // 走るが serialize されており、複数 trigger は 1 回の追加 pass に畳まれる。
    void syncWatches();
  });

  onUnmounted(() => {
    for (const dir of watchedDirs) {
      void tryCatch(rpcFsUnwatch({ dir }));
    }
    watchedDirs.clear();
  });
}
