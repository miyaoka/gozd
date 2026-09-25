import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { logEvent } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcGitFetchRemotes } from "./rpc";

/**
 * 背景 fetch の再取得周期 (ms)。**成功・失敗を区別せず単一周期**で回す（VSCode autofetch と同じ。
 * `autofetch.ts` は成否問わず `git.autofetchPeriod` を待つだけで、失敗専用 backoff を持たない）。
 * 値は PR バッジの取得 (60s) と揃える: all ブランチ表示で他人の branch の PR バッジは、その
 * `origin/*` ref が fetch 済みであることに依存するため、ref (fetch) と PR (poll) の鮮度を同一周期に
 * 揃えると整合が最良になる。gozd は fetch を可視 ∪ active repo に絞るため母数が小さく、VSCode の
 * 全 repo 180s より 60s でも負荷は同等以下。`useRemoteFetchSync` の poll tick もこの値。
 */
export const REMOTE_FETCH_INTERVAL_MS = 60_000;
/**
 * 背景 fetch の同一 repo 失敗を再通知する最小間隔 (ms)。継続失敗が 60s 周期のまま center の
 * 100 件枠を食い潰すのを防ぎつつ、恒久失敗 (認証切れ等) の再告知は保つ間隔として選んだ。
 * 初回の失敗は即通知され、成功でリセットされるため失敗エピソードごとに必ず 1 回は通知される
 * (可視 toast 上限があるため、描画までは保証しない)
 */
const FAILURE_NOTIFY_INTERVAL_MS = 30 * 60_000;

/** runFetch の結果。通知方針は経路ごとに異なるため、失敗内容を値で呼び出し側へ運ぶ */
type FetchOutcome = { ok: true } | { ok: false; detail: unknown };

/**
 * 背景失敗通知の間引き述語。前回通知が無い (失敗エピソードの先頭) か、
 * 最小間隔を超えていれば通知する。
 */
export function isFailureNotifyDue(args: {
  lastNotifiedAt: number | undefined;
  now: number;
}): boolean {
  const { lastNotifiedAt, now } = args;
  return lastNotifiedAt === undefined || now - lastNotifiedAt >= FAILURE_NOTIFY_INTERVAL_MS;
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
 * - 同時実行数は main の git admission が network 予算で絞る（TLS 接続バーストによる connect hang を
 *   断つ上限の持ち主は main。`docs/git.md` の「git の同時実行」）
 * - 成功・失敗を区別せず 60s の単一周期で lock（`REMOTE_FETCH_INTERVAL_MS`）
 * - 失敗の通知は経路ごとに方針が分かれる (`console.error` で握り潰さない)。間引く側は
 *   同一 repo を `FAILURE_NOTIFY_INTERVAL_MS` に 1 回へ絞る: 毎周期の再通知は center の 100 件枠を
 *   食い潰し、他サブシステムの未読 error を巻き添えで押し出すため。event-log には毎回
 *   detail 込みで残す。成功で間引きは解除され、次の失敗エピソードは即通知に戻る
 *
 * ## public API は 3 経路
 *
 * 軸は「backoff に従うか」と「失敗を即通知するか」。
 *
 * - `fetchIfDue(rootDir, { now? })`: 従う / 間引く。背景 poll。`isRepoFetchDue` + in-flight を
 *   gate 込みで判定し、due でなければ no-op。どの repo をいつ poll するかは `useRemoteFetchSync` の
 *   可視スコープが決め、このストアは per-repo の lock/backoff だけ持つ
 * - `requestImmediateFetch(dir)`: bypass / 即通知。ユーザーが結果を待つ操作
 * - `requestFollowUpFetch(dir)`: bypass / 間引く。自動追従。**撃てたかどうかを判断材料にする
 *   呼び出しは backoff に載せない** — lock は poll が張り直し続けるため、no-op を失敗と誤読する
 *
 * `dir` は worktree path / rootDir どちらも可。
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
  const inFlight = new Map<string, Promise<FetchOutcome>>();
  /** rootDir → 背景経路で最後に失敗を通知した時刻 (ms epoch)。成功で削除し即通知に戻す */
  const lastFailureNotifiedAt = new Map<string, number>();

  /**
   * fetch 1 回を実行し outcome を返す。inFlight にあれば同じ Promise を返して dedup。
   * 通知はしない: 通知方針は経路で異なる (背景は間引き / ユーザー起点は即時) ため、
   * in-flight dedup で promise を共有する 2 経路が各自の方針を適用できるよう、失敗内容を
   * 値として返す。event-log への記録 (毎回) はここが持つ。
   *
   * 同一 fetch を 2 経路が await した場合は各経路がそれぞれ通知する (失敗 1 回で 2 件)。
   * 発火元 1 回に寄せると immediate 経路が背景の間引き窓に飲まれ、ユーザー操作への応答が
   * 消えるため、重複のほうを許容する。
   *
   * non-public: backoff を一切読まないため直接呼びは連射の原因。公開経路とその軸は header の一覧が
   * SSOT で、ここでは数え直さない。
   */
  function runFetch(rootDir: string): Promise<FetchOutcome> {
    const name = repoStore.repos[rootDir]?.repoName ?? rootDir;
    const existing = inFlight.get(rootDir);
    if (existing !== undefined) {
      logEvent("fetch", "in-flight", name);
      return existing;
    }
    logEvent("fetch", "queue", name);

    // "fire" は main への要求の送出を指す。main の admission が network 予算の空きを待たせることがある
    const promise = (async (): Promise<FetchOutcome> => {
      logEvent("fetch", "fire", name);
      const result = await tryCatch(rpcGitFetchRemotes({ dir: rootDir }));
      nextFetchAllowedAt.set(rootDir, Date.now() + REMOTE_FETCH_INTERVAL_MS);
      if (!result.ok) {
        logEvent("fetch", "error", name, String(result.error));
        return { ok: false as const, detail: result.error };
      }
      if (!result.value.ok) {
        logEvent("fetch", "error", name, result.value.errorDetail);
        return { ok: false as const, detail: result.value.errorDetail };
      }
      logEvent("fetch", "done", name);
      lastFailureNotifiedAt.delete(rootDir);
      return { ok: true as const };
    })();

    inFlight.set(rootDir, promise);
    void promise.finally(() => inFlight.delete(rootDir));
    return promise;
  }

  /**
   * 背景経路の失敗通知。同一 repo は `FAILURE_NOTIFY_INTERVAL_MS` に 1 回へ間引く
   * (event-log には runFetch が毎回残す)。間引きは通知の抑制であって観察の抑制ではない。
   */
  function notifyBackgroundFailure(rootDir: string, detail: unknown) {
    const now = Date.now();
    if (!isFailureNotifyDue({ lastNotifiedAt: lastFailureNotifiedAt.get(rootDir), now })) return;
    lastFailureNotifiedAt.set(rootDir, now);
    notify.info(`Background git fetch failed for ${rootDir}`, detail);
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
    const outcome = await runFetch(rootDir);
    if (!outcome.ok) notifyBackgroundFailure(rootDir, outcome.detail);
    return outcome.ok;
  }

  /**
   * on-demand fetch。background polling の backoff を bypass して fetch を要求する。同時実行数の
   * 上限は main の admission が持つため、枠が埋まっていれば空き待ちが入りうる。
   *
   * `dir` は repo 配下の任意 path (worktree path / rootDir どちらも可)。内部で
   * `findRepoOwning(dir)?.rootDir` に正規化するため呼び出し側は変換不要。
   *
   * 戻り値は succeeded=true / failed=false の bool。失敗経路 (precondition violation /
   * runFetch failure) いずれも本関数内で `notify.info` が出るため、
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
    // ユーザー起点の失敗は間引かず必ず即報告する (結果を待っている操作への応答のため)
    const outcome = await runFetch(repo.rootDir);
    if (!outcome.ok) notify.info(`git fetch failed for ${repo.rootDir}`, outcome.detail);
    return outcome.ok;
  }

  /**
   * 自動追従向けの fetch。backoff は bypass し、失敗通知は間引く。
   *
   * `fetchIfDue` に載せると **ほぼ常に throttle される** — poll が同じ 60 秒間隔で lock を張り直す
   * ため。さらに in-flight でも即 false を返すので、呼び出し側は「撃たなかった」と「撃って失敗した」を
   * 区別できない。in-flight は `runFetch` の dedup が待つ。
   */
  async function requestFollowUpFetch(dir: string): Promise<boolean> {
    const repo = repoStore.findRepoOwning(dir);
    if (repo === undefined || !repo.isGitRepo) {
      logEvent(
        "fetch",
        "skip",
        repo?.repoName ?? dir,
        repo === undefined ? "untracked dir" : "not a git repo",
      );
      return false;
    }
    const outcome = await runFetch(repo.rootDir);
    if (!outcome.ok) notifyBackgroundFailure(repo.rootDir, outcome.detail);
    return outcome.ok;
  }

  return {
    fetchIfDue,
    requestImmediateFetch,
    requestFollowUpFetch,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRemoteFetchStore, import.meta.hot));
}
