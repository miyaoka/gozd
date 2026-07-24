import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { logEvent } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { ghErrorMessage, rpcGitPrList } from "../palette";

/**
 * PR 一覧の SSOT + 取得マネージャ。`gh pr list` は repo 単位で結果が同じなので、**repo
 * (rootDir) 単位でキャッシュ**し、per-repo の freshness lock で再取得を絞る。
 * `useRemoteFetchStore`（git fetch）と同型の per-repo 管理を PR list にも適用する。
 *
 * ## なぜ repo 単位キャッシュ + lock か
 *
 * claude terminals は複数 repo の worktree を並べて頻繁に切り替える。従来は active repo が
 * 変わるたびに `clear()` + `gh pr list` を無条件発射しており、repo を行き来するだけで
 * GitHub API を撃ち続けていた。repo 単位でキャッシュを保持すれば切替時はキャッシュを即表示
 * でき、`nextAllowedAt` の lock（60s）を抜けた repo だけ再取得する。
 *
 * ## 表示スコープ
 *
 * `prByBranch` は **active repo のキャッシュ**を返す computed。読み手（GitGraphPane /
 * `usePrDiffToggleStore`）はこれだけ見る。どの repo が active かは GitGraphPane が
 * `setActiveRepo` で書く（PR badge は active worktree の git graph にしか出ないため、
 * poll 対象も active repo のみ）。
 *
 * ## API スコープ
 *
 * **git-graph feature の内部 SSOT** として閉じる。barrel には export せず、外部からは
 * `usePrDiffToggleStore` 経由で間接的に読む契約。
 */

/** 成功/失敗いずれの取得後もこの間は同 repo を再取得しない (freshness lock)。interval と同値。 */
const PR_LIST_FRESH_MS = 60_000;

export const usePrListStore = defineStore("prList", () => {
  const notify = useNotificationStore();
  const repoStore = useRepoStore();

  /** repoRootDir → (head branch 名 → PR)。repo 単位でキャッシュし、切替では消さない。 */
  const cacheByRepo = ref<Map<string, Map<string, GitPullRequest>>>(new Map());
  /** repoRootDir → この時刻まで再取得を抑制する deadline (ms epoch) */
  const nextAllowedAt = new Map<string, number>();
  /** repoRootDir → in-flight な取得 (同 repo 並列発射の dedup) */
  const inFlight = new Map<string, Promise<void>>();
  /** 表示中の active repo。`prByBranch` がどの repo のキャッシュを返すかを決める。 */
  const activeRepoRootDir = ref<string>();

  const EMPTY: Map<string, GitPullRequest> = new Map();

  /** active repo の PR map。branch 名で PR を引く読み手はこれだけ見る。 */
  const prByBranch = computed(() => {
    const key = activeRepoRootDir.value;
    if (key === undefined) return EMPTY;
    return cacheByRepo.value.get(key) ?? EMPTY;
  });

  function setActiveRepo(rootDir: string | undefined) {
    activeRepoRootDir.value = rootDir;
  }

  function repoName(rootDir: string): string {
    return repoStore.repos[rootDir]?.repoName ?? rootDir;
  }

  /**
   * PR 一覧を取得して repo キャッシュに書く。inFlight にあれば同じ Promise を返して dedup。
   * 成功時はキャッシュを差し替え、失敗時は前回キャッシュを保持して `notify.error` で告知する。
   * lock は成否問わず取得後に張る（GitHub 障害中の repo 切替で撃ち続けないため）。
   */
  function runFetch(rootDir: string, dir: string): Promise<void> {
    const existing = inFlight.get(rootDir);
    if (existing !== undefined) return existing;
    logEvent("pr-poll", "fire", repoName(rootDir));
    const promise = (async () => {
      try {
        const result = await tryCatch(rpcGitPrList({ dir }));
        if (!result.ok) {
          logEvent("pr-poll", "error", repoName(rootDir), "rpc failed");
          notify.error("Failed to load pull requests", result.error);
          return;
        }
        const res = result.value;
        if (!res.ok) {
          logEvent("pr-poll", "error", repoName(rootDir), res.errorKind);
          notify.error(
            ghErrorMessage(res.errorKind, "Failed to load pull requests"),
            res.errorDetail || undefined,
          );
          return;
        }
        const map = new Map<string, GitPullRequest>();
        for (const pr of res.prs) map.set(pr.headRef, pr);
        const next = new Map(cacheByRepo.value);
        next.set(rootDir, map);
        cacheByRepo.value = next;
        logEvent("pr-poll", "done", repoName(rootDir), `${res.prs.length} prs`);
      } finally {
        nextAllowedAt.set(rootDir, Date.now() + PR_LIST_FRESH_MS);
      }
    })();
    inFlight.set(rootDir, promise);
    void promise.finally(() => inFlight.delete(rootDir));
    return promise;
  }

  /**
   * freshness lock を尊重して取得する。lock 期間中 / in-flight は no-op（キャッシュのまま）。
   * `dir` は対象 repo 配下の任意 worktree path（`gh pr list` は repo 単位で結果同一）。
   */
  function fetchIfDue(rootDir: string, dir: string, opts: { now?: number } = {}): void {
    if (inFlight.has(rootDir)) return;
    const allowedAt = nextAllowedAt.get(rootDir);
    if (allowedAt !== undefined && (opts.now ?? Date.now()) < allowedAt) {
      logEvent("pr-poll", "skip", repoName(rootDir));
      return;
    }
    void runFetch(rootDir, dir);
  }

  return { prByBranch, setActiveRepo, fetchIfDue };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrListStore, import.meta.hot));
}
