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

export interface SyncPassDeps {
  /** 今回の pass で watch しているべき dir 集合（呼び出し元が store の computed から渡す） */
  targetDirs: Set<string>;
  /** 現在 native 側で watch 中だと local に把握している dir の集合。pass 内で mutate される。 */
  watchedDirs: Set<string>;
  fsWatch: (req: { dir: string }) => Promise<unknown>;
  fsUnwatch: (req: { dir: string }) => Promise<unknown>;
  notify: { error: (message: string, cause?: unknown) => void };
  /** 新規 watch が成功するたびに、その dir を引数として呼ばれる。`fsWatchReady` 発射用。
   * subscriber は payload.dir でフィルタするため、dir 1 件につき 1 回呼ぶ。
   * dir 単位の dispatch にしないと N watch × M subscriber の fan-out で
   * 累積発火が起き、GitHub rate limit 等の上流リソースを食い潰す。 */
  dispatchReady: (dir: string) => void;
}

export async function runOneSyncPass(deps: SyncPassDeps): Promise<void> {
  const { targetDirs: next, watchedDirs, fsWatch, fsUnwatch, notify, dispatchReady } = deps;
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
  const succeededWatches: string[] = [];
  for (const dir of toWatch) {
    const r = await tryCatch(fsWatch({ dir }));
    if (!r.ok) {
      failures.push({ kind: "watch", dir, error: r.error });
      continue;
    }
    watchedDirs.add(dir);
    succeededWatches.push(dir);
  }

  if (failures.length > 0) {
    // batch 単位で 1 件に集約する。aggregate.message には summary のみを載せ、first failure
    // の Error は cause として埋める。`NotificationToastItem.vue` 側の `formatCauseChain`
    // が cause 再帰展開を行うため、トースト詳細だけで「summary + 最初の失敗の name +
    // message + stack」が読める（旧実装の文言併記 workaround は不要）。
    const summary = failures.map((f) => `${f.kind}:${f.dir}`).join(", ");
    const [first] = failures;
    const aggregate = new Error(summary, { cause: first.error });
    notify.error(`Failed to sync FS watches (${failures.length})`, aggregate);
  }

  // 新規 watch を開始した dir 1 件につき 1 回 dispatch。subscriber が payload.dir で
  // active 判定できるようにする。dispatch ループ全体で同期発射でも、購読側は世代/世代外で
  // 自然に冪等。
  for (const dir of succeededWatches) {
    dispatchReady(dir);
  }
}
