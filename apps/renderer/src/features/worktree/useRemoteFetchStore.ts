import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcGitFetchRemotes } from "./rpc";

/** 成功時の lock 期間 (ms)。VSCode の `git.autofetchPeriod` 既定値 180s と同じ */
export const REMOTE_FETCH_SUCCESS_INTERVAL_MS = 180_000;
/** 失敗時の短 backoff (ms)。起動直後の SSH unlock 待ち / 一時的 offline からの回復を捕捉する */
const REMOTE_FETCH_FAILURE_BACKOFF_MS = 30_000;

/**
 * `requestImmediateFetch` の戻り値。bool で skip と failure を畳むと呼び出し側が
 * 「fetch を打たなかった (= 別経路で recovery 可能)」と「fetch を打って失敗 (= 通知済み)」
 * を区別できず silent drop が起こる。明示 union で区別する。
 */
export type ImmediateFetchResult =
  | { kind: "succeeded" }
  | { kind: "failed" }
  | { kind: "skipped"; reason: "non-git-project" | "unknown-path" };

/**
 * `git fetch --all` の発射 SSOT。背景 polling (`useRemoteFetchSync`) と on-demand 要求
 * (`requestImmediateFetch`) の両方がこのストアの状態を共有することで、二重発射と
 * fetch 経路の分散を構造的に防ぐ。
 *
 * 既存規律:
 * - in-flight ロックで同 rootDir 並列発射を抑止 (`inFlight` Map で dedup)
 * - 成功時は 180s、失敗時は 30s の backoff
 * - 失敗は `notify.info` で通知 (CLAUDE.md `console.error で握り潰さない`)
 *
 * ## API 経路
 *
 * - `runFetch(rootDir)`: backoff を一切読まず即発射する low-level。**呼び出し側が backoff /
 *   gate を判定する責務** を持つ。背景 polling は `useRemoteFetchSync.fetchOnceIfDue` 内で
 *   `isRepoFetchDue` を通してから呼ぶ。直接呼ぶと連射の原因になる
 * - `requestImmediateFetch(dir)`: on-demand 経路。backoff を bypass し即時 fetch を要求する。
 *   `dir` は repo 配下の任意 path (worktree path / rootDir どちらも可) で、内部で
 *   `findRepoOwning(dir)?.rootDir` に正規化する。呼び出し側が rootDir 変換責務を持たない
 *
 * ロック衝突 (背景 polling 中に on-demand 要求 / 同 dir 並列 on-demand) は同じ in-flight
 * Promise を返して dedup する (重複 RPC にはならない)。
 */
export const useRemoteFetchStore = defineStore("remoteFetch", () => {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** rootDir → 「この時刻まで次の (背景) fetch を抑制」する deadline (ms epoch) */
  const nextFetchAllowedAt = new Map<string, number>();
  /** rootDir → 現在 in-flight な fetch の Promise (dedup 用) */
  const inFlight = new Map<string, Promise<boolean>>();

  function setAllowedAt(rootDir: string, value: number) {
    nextFetchAllowedAt.set(rootDir, value);
  }

  function getAllowedAt(rootDir: string): number | undefined {
    return nextFetchAllowedAt.get(rootDir);
  }

  function clearAllowedAt(rootDir: string) {
    nextFetchAllowedAt.delete(rootDir);
  }

  /**
   * fetch 1 回を実行し成功/失敗の bool を返す。inFlight にあれば同じ Promise を返して dedup。
   * 失敗は notify.info で通知し、bool false を返す。
   *
   * **呼び出し側 (背景 polling / on-demand) が backoff を gate する責務**。本関数は backoff を
   * 一切読まないため、直接呼ぶと連射する。背景 polling は `useRemoteFetchSync.fetchOnceIfDue`
   * 内で `isRepoFetchDue` を通してから呼ぶ。on-demand は `requestImmediateFetch` 経由で呼ぶ。
   */
  function runFetch(rootDir: string): Promise<boolean> {
    const existing = inFlight.get(rootDir);
    if (existing !== undefined) return existing;

    const promise = (async () => {
      const result = await tryCatch(rpcGitFetchRemotes({ dir: rootDir }));
      const now = Date.now();
      if (!result.ok) {
        notify.info(`Background git fetch failed for ${rootDir}`, result.error);
        nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_FAILURE_BACKOFF_MS);
        return false;
      }
      if (!result.value.ok) {
        notify.info(`Background git fetch failed for ${rootDir}`, result.value.errorDetail);
        nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_FAILURE_BACKOFF_MS);
        return false;
      }
      nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_SUCCESS_INTERVAL_MS);
      return true;
    })();

    inFlight.set(rootDir, promise);
    void promise.finally(() => inFlight.delete(rootDir));
    return promise;
  }

  /**
   * on-demand fetch。background polling の backoff を bypass し、即時 fetch を要求する。
   *
   * `dir` は repo 配下の任意 path (worktree path / rootDir どちらも可)。内部で
   * `findRepoOwning(dir)?.rootDir` に正規化するため呼び出し側は変換不要。
   *
   * 戻り値は `succeeded` / `failed` / `skipped` の 3 値 union:
   * - skip 系 (`non-git-project` / `unknown-path`) は通知を出さない (呼び出し側が文脈付きの
   *   トーストを出すべき経路)
   * - `failed` は `runFetch` 内で `notify.info` が既に出ているので呼び出し側は重ねない
   * - `succeeded` は通常通り処理を続ける
   */
  async function requestImmediateFetch(dir: string): Promise<ImmediateFetchResult> {
    const repo = repoStore.findRepoOwning(dir);
    if (repo === undefined) return { kind: "skipped", reason: "unknown-path" };
    if (!repo.isGitRepo) return { kind: "skipped", reason: "non-git-project" };
    const ok = await runFetch(repo.rootDir);
    return ok ? { kind: "succeeded" } : { kind: "failed" };
  }

  return {
    runFetch,
    requestImmediateFetch,
    setAllowedAt,
    getAllowedAt,
    clearAllowedAt,
    /** background polling 側の in-flight ロック判定用 */
    hasInFlight: (rootDir: string) => inFlight.has(rootDir),
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRemoteFetchStore, import.meta.hot));
}
