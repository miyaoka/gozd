/**
 * gozd が開いている全 repo / 全 worktree の dir を native 側 `FSWatchRegistry` に同期して
 * watch させる app-scope な watcher。
 *
 * 設計判断:
 *
 * - 単一 active worktree だけを watch する旧設計は、別 repo / 別 worktree で起きた
 *   commit / rename / push を取りこぼす。gozd は「window 内マルチ repo + マルチ worktree」
 *   が機能要件なので、watch も全 worktree を均等に対象とする
 * - `repoStore.fsWatchTargetDirs` (computed) の変化を `watch` で追い、差分を
 *   `rpcFsWatch` / `rpcFsUnwatch` で発射する。watch 対象集合の計算ロジックは store に
 *   閉じている（SSOT: repos の所有者 = 派生値の所有者）
 * - 非 git project（`isGitRepo === false`）は rootDir そのものを watch（FS 変化のみ）
 * - 失敗はトーストで通知（CLAUDE.md 規律）。複数同時失敗は集約 1 件にする
 * - 新規 watch 開始後に `fsWatchReady` を発射して、購読側に 1 度だけ再同期させる
 * - **並列実行を generation で serialize する**: `watch` は依存変更で再 run するが
 *   前回の async コールバック完了を待たない。前回が `watchedDirs` を更新する前に次回が
 *   走ると、削除済み worktree の watch が永続的に残るレースが起きる。前回完了まで次回を
 *   coalesce することで `watchedDirs` の整合性を保つ
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { dispatchMessage } from "../../shared/rpc";
import { rpcFsUnwatch, rpcFsUnwatchAll, rpcFsWatch } from "./rpc";
import { runOneSyncPass } from "./runOneSyncPass";
import { runSerializedSync, type SerializeState, whenIdle } from "./runSerializedSync";

export function useFsWatchSync() {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** 現在 native 側で watch 中だと local に把握している dir の集合。
   * 差分計算の baseline で、 `rpcFsWatch` / `rpcFsUnwatch` の発射対象を絞るために使う。 */
  const watchedDirs = new Set<string>();

  /** `syncWatches` の serialize 用 state。`runSerializedSync` に渡す mutex 兼 coalesce フラグ。
   * 実体ロジックは `runSerializedSync.ts` 側の pure helper に切り出し、test で race coalesce
   * 挙動を直接検証している。 */
  const serializeState: SerializeState = { running: false, pending: false, currentRun: null };

  /** unmount 開始フラグ。`true` 以降は新規 sync を抑制して、in-flight の完走後に
   * `rpcFsUnwatchAll` を発射する drain 経路を成立させる。`watch` は Vue が
   * 自動 dispose するが、その時点で残っている async chain が `fsWatch(X)` を native に
   * 発火する race を closing する。 */
  let disposing = false;

  async function syncWatches(targetDirs: Set<string>): Promise<void> {
    await runSerializedSync(serializeState, () =>
      runOneSyncPass({
        targetDirs,
        watchedDirs,
        fsWatch: rpcFsWatch,
        fsUnwatch: rpcFsUnwatch,
        notify,
        dispatchReady: () => dispatchMessage("fsWatchReady", {}),
      }),
    );
  }

  // store の computed `fsWatchTargetDirs` が変化するたびに sync する。
  // `collectFsWatchTargetDirs` が毎回新しい `Set<string>` を返すので、reactive 変化が
  // あれば必ず callback 起動する（`===` 比較）。実 RPC は async だが `runSerializedSync` で
  // single-flight + coalesce されており、複数 trigger は 1 回の追加 pass に畳まれる。
  watch(
    () => repoStore.fsWatchTargetDirs,
    (targetDirs) => {
      // unmount 中は新規 sync を抑制する。Vue の watch dispose が走る前に reactive
      // trigger が来ても、ここで guard することで `fsWatch` が native に追加発火しない。
      if (disposing) return;
      void syncWatches(targetDirs);
    },
    { immediate: true },
  );

  onUnmounted(() => {
    disposing = true;
    // 在 in-flight の `runOneSyncPass` がある場合、その fsWatch / fsUnwatch RPC の完走を
    // 待ってから `rpcFsUnwatchAll` を発射する。これで「unwatchAll の後に fsWatch(X) が
    // native に届いて X が leak する」race window を構造的に閉じる。
    // unwatchAll 失敗は `notify.error` で観察可能性を残す（アプリ終了 race で UI 上に
    // 見えない場合も store 内の console.error が devtools に残る）。
    void (async () => {
      await whenIdle(serializeState);
      const r = await tryCatch(rpcFsUnwatchAll({}));
      if (!r.ok) {
        notify.error("Failed to cleanup FS watches", r.error);
      }
      watchedDirs.clear();
    })();
  });
}
