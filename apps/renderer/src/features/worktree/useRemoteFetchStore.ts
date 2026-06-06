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
 * 1 repo が「いま fetch すべき対象か」を決める唯一の述語。
 *
 * - **focus 喪失中は対象外**: 背景 fetch は focus 中だけ回す。focus が無いと false を返し
 *   `nextFetchAllowedAt` に何も記録しないため、focus 復帰時に同経路が再判定して取りこぼしを救う
 * - **backoff / lock 中は対象外**: `allowedAt` が未来なら抑制期間中
 * - **非 git project は対象外**: fetch する remote が無い
 *
 * in-flight 抑止は Set の副作用なので呼び出し側で別途 guard する (純粋判定には含めない)。
 * 純粋関数として `useRemoteFetchStore` から export し、`fetchIfDue` 内部と test の両方が
 * 同じ判定ロジックを共有する。
 */
export function isRepoFetchDue(args: {
  repo: { isGitRepo: boolean } | undefined;
  focused: boolean;
  allowedAt: number | undefined;
  now: number;
}): boolean {
  const { repo, focused, allowedAt, now } = args;
  if (!focused) return false;
  if (allowedAt !== undefined && now < allowedAt) return false;
  if (repo === undefined || !repo.isGitRepo) return false;
  return true;
}

/**
 * `git fetch --all` の発射 SSOT。背景 polling (`useRemoteFetchSync`) と on-demand 要求の
 * 両方がこのストアの状態 (in-flight Map / backoff deadline Map) を共有することで、
 * 二重発射と fetch 経路の分散を構造的に防ぐ。
 *
 * 既存規律:
 * - in-flight ロックで同 rootDir 並列発射を抑止 (`inFlight` Map で dedup)
 * - 成功時は 180s、失敗時は 30s の backoff
 * - 失敗は `notify.info` で通知 (CLAUDE.md `console.error で握り潰さない`)
 *
 * ## public API は 2 経路のみ
 *
 * - `fetchIfDue(rootDir, { focused, now? })`: 背景 polling 経路。`isRepoFetchDue` + in-flight を
 *   gate 込みで判定し、due なら fetch を発射する。due でなければ no-op。背景 polling が直接
 *   `isRepoFetchDue` を読まなくて済むよう、gate と発射を 1 関数に閉じる
 * - `requestImmediateFetch(dir)`: on-demand 経路。background polling の backoff を bypass し
 *   即時 fetch を要求する。`dir` は worktree path / rootDir どちらも可で内部正規化する
 *
 * 内部 `runFetch` は public に出さない。直接呼びで backoff を bypass 連射する経路を
 * 型レベルで塞ぐため、外部からアクセス不可能な closure に閉じる。
 *
 * `clearAllowedAt(rootDir)` は focus 復帰時の即時 fetch をリカバリするため `useRemoteFetchSync`
 * から呼ばれる専用 API。背景 polling lifecycle 固有の concern なのでここに残す。
 */
export const useRemoteFetchStore = defineStore("remoteFetch", () => {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** rootDir → 「この時刻まで次の (背景) fetch を抑制」する deadline (ms epoch) */
  const nextFetchAllowedAt = new Map<string, number>();
  /** rootDir → 現在 in-flight な fetch の Promise (dedup 用) */
  const inFlight = new Map<string, Promise<boolean>>();

  function clearAllowedAt(rootDir: string) {
    nextFetchAllowedAt.delete(rootDir);
  }

  /**
   * fetch 1 回を実行し成功/失敗の bool を返す。inFlight にあれば同じ Promise を返して dedup。
   * 失敗は notify.info で通知し、bool false を返す。
   *
   * non-public: backoff を一切読まないため直接呼びは連射の原因。`fetchIfDue` (gate 込み) と
   * `requestImmediateFetch` (gate bypass 意図) の 2 経路から呼び分ける。
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
   * 背景 polling 用の gate 込み発射経路。in-flight / backoff / focus / git repo の判定を
   * すべて store 内に閉じる。due でなければ no-op (false を返す)。
   *
   * 呼び出し側 (`useRemoteFetchSync`) は `focused` のみを渡せば良く、polling 経路ごとに
   * isRepoFetchDue を直接読む責務を持たない。
   */
  async function fetchIfDue(
    rootDir: string,
    opts: { focused: boolean; now?: number },
  ): Promise<boolean> {
    if (inFlight.has(rootDir)) return false;
    const due = isRepoFetchDue({
      repo: repoStore.repos[rootDir],
      focused: opts.focused,
      allowedAt: nextFetchAllowedAt.get(rootDir),
      now: opts.now ?? Date.now(),
    });
    if (!due) return false;
    return await runFetch(rootDir);
  }

  /**
   * on-demand fetch。background polling の backoff を bypass し、即時 fetch を要求する。
   *
   * `dir` は repo 配下の任意 path (worktree path / rootDir どちらも可)。内部で
   * `findRepoOwning(dir)?.rootDir` に正規化するため呼び出し側は変換不要。
   *
   * 戻り値は succeeded=true / failed=false の bool。失敗経路 (precondition violation /
   * runFetch failure) いずれも本関数または `runFetch` 内で `notify.info` が出るため、
   * 呼び出し側は false 戻り値に対して追加通知を出さない契約。
   *
   * precondition violation (`findRepoOwning` undefined / 非 git repo) は本来発生しないが
   * (caller 側で「dir が git worktree であること」を gate する責務がある)、race (例: caller の
   * gate 評価後に worktree が削除される) で踏みうるため、silent drop せず notify.info で
   * 観察可能化する。
   */
  async function requestImmediateFetch(dir: string): Promise<boolean> {
    const repo = repoStore.findRepoOwning(dir);
    if (repo === undefined) {
      notify.info(`Background fetch skipped: ${dir} is not a tracked git worktree`);
      return false;
    }
    if (!repo.isGitRepo) {
      notify.info(`Background fetch skipped: ${dir} is not a git repository`);
      return false;
    }
    return await runFetch(repo.rootDir);
  }

  return {
    fetchIfDue,
    requestImmediateFetch,
    clearAllowedAt,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRemoteFetchStore, import.meta.hot));
}
