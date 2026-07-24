import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { logEvent } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcGitFetchRemotes } from "./rpc";

/**
 * 背景 fetch の再取得周期 (ms)。**成功・失敗を区別せず単一周期**で回す（VSCode autofetch と同じ。
 * `autofetch.ts` は成否問わず `git.autofetchPeriod` を待つだけで、失敗専用 backoff を持たない）。
 * 値は PR poll (`gh pr list`, 60s) と揃える: all ブランチ表示で他人の branch の PR バッジは、その
 * `origin/*` ref が fetch 済みであることに依存するため、ref (fetch) と PR (poll) の鮮度を同一周期に
 * 揃えると整合が最良になる。gozd は fetch を可視 ∪ active repo に絞るため母数が小さく、VSCode の
 * 全 repo 180s より 60s でも負荷は同等以下。`useRemoteFetchSync` の poll tick もこの値。
 */
export const REMOTE_FETCH_INTERVAL_MS = 60_000;
/**
 * 背景 fetch の同時実行上限。可視集合（`useRemoteFetchSync` の対象「画面に写っている repo ∪
 * active repo」）が一度に多数入る（mount 時 / スクロールで多数カードが可視化）と、対象 repo が
 * 同時に fetch を要求しうる。無制限だと N 本の `git fetch` が同一瞬間に同一ホストへ TLS 接続を
 * 張り、バーストで負けた接続が確立できず OS TCP timeout（~75s）まで hang する。git には connect
 * timeout を縛る config が無い（`http.lowSpeedLimit/Time` は接続後の転送しか縛れない）ため、
 * 発射側で同時数を絞る。VSCode が複数 repo 横断の初期 git 操作を並列 5 に絞る
 * （microsoft/vscode `Limiter<void>(5)`, issue #318279 ext host starvation 回避）のと同値・同理由。
 */
const MAX_CONCURRENT_FETCH = 5;

/**
 * 同時実行数を `concurrency` に絞るキュー。VSCode の `Limiter`
 * (microsoft/vscode `extensions/git/src/util.ts`) を、class 禁止の gozd 規約に合わせ関数化して
 * 移植した。`outstanding` に積んだ factory を、実行中 (`running`) が上限未満のあいだ `consume` が
 * while で dequeue して発火し、1 つ完了 (成否問わず) するごとに `consumed` が枠を返して再 consume
 * する。factory の解決値 / reject は呼び出し側へ透過する。単一 consumer のためここに閉じ shared 化しない。
 */
export function createConcurrencyLimiter<T>(concurrency: number) {
  interface QueuedTask {
    factory: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason: unknown) => void;
  }
  const outstanding: QueuedTask[] = [];
  let running = 0;

  function consume() {
    while (outstanding.length > 0 && running < concurrency) {
      const task = outstanding.shift();
      if (task === undefined) return;
      running++;
      // factory() が Promise を返す前に同期 throw しても、reject 経路に載せて枠を必ず解放するため
      // async で包む (裸で呼ぶと throw が consume を抜け running が減らず、cap 回累積で deadlock する)
      const promise = (async () => task.factory())();
      // 解決値 / reject を caller へ透過。別の then で成否どちらでも枠を返す
      // (両ハンドラが consumed のため reject は再送されず unhandled にならない)
      void promise.then(task.resolve, task.reject);
      void promise.then(consumed, consumed);
    }
  }

  function consumed() {
    running--;
    if (outstanding.length > 0) consume();
  }

  return (factory: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      outstanding.push({ factory, resolve, reject });
      consume();
    });
}

/**
 * 1 repo が「いま fetch すべき対象か」を決める唯一の述語。
 *
 * - **backoff / lock 中は対象外**: `allowedAt` が未来なら抑制期間中
 * - **非 git project は対象外**: fetch する remote が無い
 *
 * どの repo を対象にするか（active + 画面に写っている repo）は `useRemoteFetchSync` の
 * 可視スコープが決める。この述語は「対象と決まった repo が lock 期間を抜けたか」だけを見る。
 * in-flight 抑止は Set の副作用なので呼び出し側で別途 guard する (純粋判定には含めない)。
 */
export function isRepoFetchDue(args: {
  repo: { isGitRepo: boolean } | undefined;
  allowedAt: number | undefined;
  now: number;
}): boolean {
  const { repo, allowedAt, now } = args;
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
 * - 全 fetch 経路が共有する `fetchLimiter` (`createConcurrencyLimiter(MAX_CONCURRENT_FETCH)`) で
 *   同時実行数を絞る。可視集合の同時 fetch が cap を超えたぶんは queue し、TLS 接続バーストによる
 *   connect hang を断つ
 * - 成功・失敗を区別せず 60s の単一周期で lock（`REMOTE_FETCH_INTERVAL_MS`）
 * - 失敗は `notify.info` の persist 指定で通知 (CLAUDE.md `console.error で握り潰さない`)。
 *   background 発火でユーザーが目撃前に自動消去されると silent drop と等価になるため、
 *   手動クローズまで残す
 *
 * ## public API は 2 経路のみ
 *
 * - `fetchIfDue(rootDir, { now? })`: 背景 poll 経路。`isRepoFetchDue` + in-flight を gate 込みで
 *   判定し、due なら fetch を発射する。due でなければ no-op。どの repo をいつ poll するかは
 *   `useRemoteFetchSync` の可視スコープが決め、このストアは per-repo の lock/backoff だけ持つ
 * - `requestImmediateFetch(dir)`: on-demand 経路。background poll の backoff を bypass して
 *   fetch を要求する。ただし `fetchLimiter` の同時実行 cap は共有するため、cap が埋まっていれば
 *   slot 空き待ちが入りうる (backoff は bypass するが並列度は共有)。`dir` は worktree path /
 *   rootDir どちらも可で内部正規化する
 *
 * 内部 `runFetch` は public に出さない。直接呼びで backoff を bypass 連射する経路を
 * 型レベルで塞ぐため、外部からアクセス不可能な closure に閉じる。
 */
export const useRemoteFetchStore = defineStore("remoteFetch", () => {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** rootDir → 「この時刻まで次の (背景) fetch を抑制」する deadline (ms epoch) */
  const nextFetchAllowedAt = new Map<string, number>();
  /** rootDir → 現在 in-flight な fetch の Promise (dedup 用) */
  const inFlight = new Map<string, Promise<boolean>>();
  /** 全 fetch 経路が共有する同時実行上限キュー。cap 超過ぶんは queue され順に実行される */
  const fetchLimiter = createConcurrencyLimiter<boolean>(MAX_CONCURRENT_FETCH);

  /**
   * fetch 1 回を実行し成功/失敗の bool を返す。inFlight にあれば同じ Promise を返して dedup。
   * 失敗は notify.info で通知し、bool false を返す。
   *
   * non-public: backoff を一切読まないため直接呼びは連射の原因。`fetchIfDue` (gate 込み) と
   * `requestImmediateFetch` (gate bypass 意図) の 2 経路から呼び分ける。
   */
  function runFetch(rootDir: string): Promise<boolean> {
    const name = repoStore.repos[rootDir]?.repoName ?? rootDir;
    const existing = inFlight.get(rootDir);
    if (existing !== undefined) {
      logEvent("fetch", "in-flight", name);
      return existing;
    }
    logEvent("fetch", "queue", name);

    // cap 超過ぶんは fetchLimiter が queue し、slot が空いてから実行する。"fire" は queue 通過後の
    // 実ネットワーク開始を指す (queue と fire の間隔で発射バーストの詰まりが観察できる)。
    const promise = fetchLimiter(async () => {
      logEvent("fetch", "fire", name);
      const result = await tryCatch(rpcGitFetchRemotes({ dir: rootDir }));
      const now = Date.now();
      if (!result.ok) {
        logEvent("fetch", "error", name);
        notify.info(`Background git fetch failed for ${rootDir}`, result.error, { persist: true });
        nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_INTERVAL_MS);
        return false;
      }
      if (!result.value.ok) {
        logEvent("fetch", "error", name);
        notify.info(`Background git fetch failed for ${rootDir}`, result.value.errorDetail, {
          persist: true,
        });
        nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_INTERVAL_MS);
        return false;
      }
      logEvent("fetch", "done", name);
      nextFetchAllowedAt.set(rootDir, now + REMOTE_FETCH_INTERVAL_MS);
      return true;
    });

    inFlight.set(rootDir, promise);
    void promise.finally(() => inFlight.delete(rootDir));
    return promise;
  }

  /**
   * 背景 poll 用の gate 込み発射経路。in-flight / backoff / git repo の判定を store 内に
   * 閉じる。due でなければ no-op (false を返す)。対象 repo の選定 (可視スコープ) は
   * `useRemoteFetchSync` が持ち、この関数は lock を抜けたかだけ見る。
   */
  async function fetchIfDue(rootDir: string, opts: { now?: number } = {}): Promise<boolean> {
    if (inFlight.has(rootDir)) return false;
    const due = isRepoFetchDue({
      repo: repoStore.repos[rootDir],
      allowedAt: nextFetchAllowedAt.get(rootDir),
      now: opts.now ?? Date.now(),
    });
    if (!due) {
      logEvent("fetch", "skip", repoStore.repos[rootDir]?.repoName ?? rootDir);
      return false;
    }
    return await runFetch(rootDir);
  }

  /**
   * on-demand fetch。background polling の backoff を bypass して fetch を要求する。ただし
   * `fetchLimiter` の同時実行 cap は共有するため、cap が埋まっていれば slot 空き待ちが入りうる。
   *
   * `dir` は repo 配下の任意 path (worktree path / rootDir どちらも可)。内部で
   * `findRepoOwning(dir)?.rootDir` に正規化するため呼び出し側は変換不要。
   *
   * 戻り値は succeeded=true / failed=false の bool。失敗経路 (precondition violation /
   * runFetch failure) いずれも本関数または `runFetch` 内で `notify.info` が出るため、
   * 呼び出し側は false 戻り値に対して追加通知を出さない契約。
   *
   * 不正 path (`findRepoOwning` undefined / 非 git repo) は `notify.info` で skip し false を返す。
   * silent drop しないことで、(a) race (caller の gate 評価後に worktree が削除される) (b) 任意
   * path を gate なしで呼ぶ caller、のいずれも観察可能になる。
   */
  async function requestImmediateFetch(dir: string): Promise<boolean> {
    const repo = repoStore.findRepoOwning(dir);
    if (repo === undefined || !repo.isGitRepo) {
      notify.info("git fetch skipped: target worktree is no longer tracked");
      return false;
    }
    return await runFetch(repo.rootDir);
  }

  return {
    fetchIfDue,
    requestImmediateFetch,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRemoteFetchStore, import.meta.hot));
}
