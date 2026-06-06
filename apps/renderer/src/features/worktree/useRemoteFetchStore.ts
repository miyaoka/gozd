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
 * `git fetch --all` の発射 SSOT。背景 polling (`useRemoteFetchSync`) と on-demand 要求
 * (`requestImmediateFetch`) の両方がこのストアの状態を共有することで、二重発射と
 * fetch 経路の分散を構造的に防ぐ。
 *
 * 既存規律:
 * - in-flight ロックで同 dir 並列発射を抑止
 * - 成功時は 180s、失敗時は 30s の backoff
 * - 失敗は `notify.info` で通知 (CLAUDE.md `console.error で握り潰さない`)
 *
 * on-demand 経路 (PR diff の base reachable 確認後 fetch 等) は backoff を bypass する。
 * 「ユーザー意図に応じて即時 fetch する」要件は背景 polling と排他的なので、ロック衝突したら
 * 同じ in-flight Promise を返して dedup する (重複 fetch にはならない)。
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
   * 失敗は notify.info で通知し、bool false を返す。背景 polling / on-demand 両方の core。
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
   * 同 dir に in-flight な fetch (背景 polling 由来 / 他の on-demand 由来) があれば、
   * その Promise を返して dedup する。重複 RPC は発射しない。
   *
   * 非 git project / 不在 dir は false を返す (fetch する remote が無い)。
   */
  async function requestImmediateFetch(rootDir: string): Promise<boolean> {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined || !repo.isGitRepo) return false;
    return await runFetch(rootDir);
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
