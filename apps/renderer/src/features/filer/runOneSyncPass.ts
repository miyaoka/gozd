/**
 * `useFsWatchSync` の 1 回の sync pass 本体。`watchedDirs` と target dir 集合の差分を
 * 計算して `fsWatch` / `fsUnwatch` を発射し、失敗を 1 件のトーストに集約する。
 *
 * 切り出した理由:
 * - `useFsWatchSync.ts` は Vue の `watchEffect` / `onUnmounted` / Pinia store を直接
 *   触るため、bun test で import するには Vue / DOM の整備が前提になる
 * - 1 pass のロジックは「差分計算 + RPC 発射 + 失敗集約 + Ready 通知」で完結しており、
 *   依存を引数で受け取れば pure 関数として直接呼べる
 *
 * 副作用は `watchedDirs` の mutation と `notify.error` / `fsWatch` / `fsUnwatch` /
 * `dispatchReady` の呼び出しのみで、いずれも引数経由。production 側は固定の依存を
 * 渡す薄い wrapper を持つ。
 */
import { tryCatch } from "@gozd/shared";
import { collectTargetDirs, type RepoStoreForTargetDirs } from "./collectTargetDirs";

export interface SyncPassDeps {
  repoStore: RepoStoreForTargetDirs;
  /** 現在 native 側で watch 中だと local に把握している dir の集合。pass 内で mutate される。 */
  watchedDirs: Set<string>;
  fsWatch: (req: { dir: string }) => Promise<unknown>;
  fsUnwatch: (req: { dir: string }) => Promise<unknown>;
  notify: { error: (message: string, cause?: unknown) => void };
  /** 新規 watch が 1 つでも成功した時に呼ばれる。`fsWatchReady` 発射用。 */
  dispatchReady: () => void;
}

export async function runOneSyncPass(deps: SyncPassDeps): Promise<void> {
  const { repoStore, watchedDirs, fsWatch, fsUnwatch, notify, dispatchReady } = deps;

  const next = collectTargetDirs(repoStore);
  const toUnwatch: string[] = [];
  const toWatch: string[] = [];
  for (const dir of watchedDirs) {
    if (!next.has(dir)) toUnwatch.push(dir);
  }
  for (const dir of next) {
    if (!watchedDirs.has(dir)) toWatch.push(dir);
  }

  const failures: Array<{ kind: "watch" | "unwatch"; dir: string; error: Error }> = [];

  for (const dir of toUnwatch) {
    const r = await tryCatch(fsUnwatch({ dir }));
    if (!r.ok) {
      failures.push({ kind: "unwatch", dir, error: r.error });
    }
    // 失敗してもローカル set からは外す。native 側 watch は「既存 entry があれば破棄して
    // 再構築」する設計なので、ローカル set と native 側で乖離しても次回の `fsWatch`
    // で永続的不整合は解消される。再 watch が走らないケースでも `onUnmounted` の
    // `rpcFsUnwatchAll` で native 側残骸は一括破棄される。
    watchedDirs.delete(dir);
  }
  for (const dir of toWatch) {
    const r = await tryCatch(fsWatch({ dir }));
    if (!r.ok) {
      failures.push({ kind: "watch", dir, error: r.error });
      continue;
    }
    watchedDirs.add(dir);
  }

  if (failures.length > 0) {
    // batch 単位で 1 件に集約する。トースト UI は cause chain の最上位だけ展開する
    // （cause.cause は表示しない）ため、aggregate.message に summary と
    // first.error.message の両方を載せて、トーストの詳細展開だけで「件数 + どの
    // kind:dir + 最初の失敗の原因文言」が見えるようにする。
    const summary = failures.map((f) => `${f.kind}:${f.dir}`).join(", ");
    const [first] = failures;
    const aggregate = new Error(`${summary} -- first error: ${first.error.message}`, {
      cause: first.error,
    });
    notify.error(`Failed to sync FS watches (${failures.length})`, aggregate);
  }

  const watchFailures = failures.filter((f) => f.kind === "watch").length;
  const successfulWatches = toWatch.length - watchFailures;
  if (successfulWatches > 0) {
    // 「Ready」というイベント名と実態を一致させるため、新規 watch が 1 つでも成功した
    // 場合に限って発射する（全 watch が失敗した場合は新たに監視対象になった dir が無く、
    // 救済する取りこぼし対象も存在しない）。
    dispatchReady();
  }
}
