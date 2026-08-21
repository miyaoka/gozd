import type { GitPullRequestBadge } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { logEvent } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { ghErrorLogDetail, ghErrorMessage } from "../github-item";
import { rpcGitPrsForBranches } from "./rpc";

/**
 * グラフの ref バッジが読む PR の SSOT + 取得マネージャ。
 *
 * ## 引く単位は「描いている branch」
 *
 * repo の open PR を全件取ってから branch 名で突き合わせるのではなく、**描く branch を名指しで
 * 引く**。取得コストが repo の PR 総数から切り離され、上限で切れて「PR を持たない branch」に
 * 化ける経路も無くなる。描いていない branch の PR は誰も読まないので、取る意味が無い。
 *
 * PR を選ばせるための一覧（picker）は別の問いなので別経路で取る。運ぶ範囲も発火の頻度も違う。
 *
 * ## 鮮度は branch ごとに持つ
 *
 * 「repo 単位のキャッシュ + 直近の問いとの一致」で lock を掛けると、**問いが少しでも違えば
 * lock ごと外れる**。グラフに載る ref は worktree ごとに違うので、同一 repo 内の切替でも毎回
 * 取り直すことになり、失敗した後は「前回の問い」が残らないので lock が永久に効かなくなる。
 *
 * branch ごとに取得時刻を持てば、切替で増えた branch だけを取り、失敗した branch だけが
 * 次の対象になる。応答は**差し替えではなく merge** するので、まだ正しい問いを立てられていない
 * tick が既存のキャッシュを壊すこともない。
 *
 * ## 表示スコープ
 *
 * `prByBranch` は **active repo のキャッシュ**を返す computed。「active repo」は
 * `repoStore.selectedRootDir` を SSOT に直接導出する（別 ref にミラーしない）。
 *
 * ## API スコープ
 *
 * **git-graph feature の内部 SSOT** として閉じる。バレルには export せず、外部からは
 * `usePrDiffToggleStore` 経由で間接的に読む契約。
 */

/** 取得後この間は同じ branch を引き直さない (freshness lock)。interval と同値。 */
export const PR_BADGE_FRESH_MS = 60_000;

/** branch 1 本ぶんの取得結果。`pr` が undefined は「引いたが PR が無かった」。 */
export interface PrBadgeEntry {
  pr?: GitPullRequestBadge;
  /** 最後にこの branch を引いた時刻 (ms epoch)。成否を問わず更新する。 */
  fetchedAt: number;
}

/**
 * 引き直しが要る branch を返す純関数。未取得か、取得から `PR_BADGE_FRESH_MS` 以上経ったもの。
 *
 * **失敗した取得でも時刻は進める**（呼び出し側の契約）。進めないと、GitHub 障害中に
 * interval・push・切替のたびに撃ち直してトーストを積む。
 */
export function staleBranches(args: {
  entries: Map<string, PrBadgeEntry> | undefined;
  branches: string[];
  now: number;
}): string[] {
  const { entries, branches, now } = args;
  return branches.filter((branch) => {
    const entry = entries?.get(branch);
    return entry === undefined || now - entry.fetchedAt >= PR_BADGE_FRESH_MS;
  });
}

/**
 * 取得結果を branch → entry の map へ畳む純関数。要求した branch の時刻は成否を問わず進める。
 *
 * **差し替えではなく merge**。要求に含まれない branch のキャッシュは触らないので、まだ正しい
 * 問いを立てられていない取得が既存のキャッシュを壊さない。
 *
 * **失敗（`prs` が undefined）では前回の PR を保つ**。時刻だけ進めて lock を張り、GitHub 障害中の
 * 撃ち直しを止める。応答に含まれない要求 branch は「引いたが PR が無かった」なので `pr` を落とす。
 */
export function mergeBadgeEntries(args: {
  entries: Map<string, PrBadgeEntry> | undefined;
  branches: string[];
  prs: GitPullRequestBadge[] | undefined;
  now: number;
}): Map<string, PrBadgeEntry> {
  const { entries, branches, prs, now } = args;
  const next = new Map(entries ?? []);
  const found = new Map(prs?.map((pr) => [pr.headRef, pr]));
  for (const branch of branches) {
    const pr = prs === undefined ? next.get(branch)?.pr : found.get(branch);
    next.set(branch, { pr, fetchedAt: now });
  }
  return next;
}

export const usePrBadgeStore = defineStore("prBadge", () => {
  const notify = useNotificationStore();
  const repoStore = useRepoStore();

  /** repoRootDir → (branch 名 → 取得結果)。repo 単位でキャッシュし、切替では消さない。 */
  const cacheByRepo = ref<Map<string, Map<string, PrBadgeEntry>>>(new Map());
  /**
   * repoRootDir → いま取得中の branch。**repo 単位で排他しない。**
   *
   * 取得中を「後で撃ち直す」形にすると、その再入は呼び出し側の条件（focus 中か、いまどの repo を
   * 見ているか、いま何を描いているか）を通らない。捕捉した引数で撃つため、blur した後や別の repo
   * へ移った後に発火する。取得中の branch を引き算すれば、同じ branch を二重に引かないという
   * 目的だけが残り、遅延実行が要らなくなる。
   */
  const inFlight = new Map<string, Set<string>>();

  const EMPTY: Map<string, GitPullRequestBadge> = new Map();

  /**
   * active repo の PR map。branch 名で PR を引く読み手 (GitGraphPane / usePrDiffToggleStore) は
   * これだけ見る。「active repo」は `repoStore.selectedRootDir` を SSOT に直接導出する
   * (別 ref にミラーすると SSOT が二重化し、正しさが GitGraphPane の mount 状態に結びつくため)。
   */
  const prByBranch = computed(() => {
    const key = repoStore.selectedRootDir;
    if (key === undefined) return EMPTY;
    const entries = cacheByRepo.value.get(key);
    if (entries === undefined) return EMPTY;
    const map = new Map<string, GitPullRequestBadge>();
    for (const [branch, entry] of entries) {
      if (entry.pr !== undefined) map.set(branch, entry.pr);
    }
    return map;
  });

  function repoName(rootDir: string): string {
    return repoStore.repos[rootDir]?.repoName ?? rootDir;
  }

  /** 取得結果を repo のキャッシュへ merge する。畳み方の契約は `mergeBadgeEntries`。 */
  function merge(rootDir: string, branches: string[], prs: GitPullRequestBadge[] | undefined) {
    const next = new Map(cacheByRepo.value);
    next.set(
      rootDir,
      mergeBadgeEntries({ entries: next.get(rootDir), branches, prs, now: Date.now() }),
    );
    cacheByRepo.value = next;
  }

  /**
   * 指定 branch の PR を取得してキャッシュへ merge する。inFlight にあれば同じ Promise を返す。
   * 失敗はキャッシュを保ったまま `notify.error` で告知する。
   */
  function runFetch(rootDir: string, dir: string, branches: string[]): void {
    const running = inFlight.get(rootDir) ?? new Set<string>();
    for (const branch of branches) running.add(branch);
    inFlight.set(rootDir, running);
    logEvent("pr-badge", "fire", repoName(rootDir), `${branches.length} branches`);
    const promise = (async () => {
      const result = await tryCatch(rpcGitPrsForBranches({ dir, branches }));
      if (!result.ok) {
        logEvent("pr-badge", "error", repoName(rootDir), String(result.error));
        notify.error("Failed to load pull requests", result.error);
        merge(rootDir, branches, undefined);
        return;
      }
      const res = result.value;
      if (!res.ok) {
        logEvent(
          "pr-badge",
          "error",
          repoName(rootDir),
          ghErrorLogDetail(res.errorKind, res.errorDetail),
        );
        notify.error(
          ghErrorMessage(res.errorKind, "Failed to load pull requests"),
          res.errorDetail || undefined,
        );
        merge(rootDir, branches, undefined);
        return;
      }
      merge(rootDir, branches, res.prs);
      logEvent("pr-badge", "done", repoName(rootDir), `${res.prs.length} prs`);
    })();
    void promise.finally(() => {
      for (const branch of branches) running.delete(branch);
      if (running.size === 0) inFlight.delete(rootDir);
    });
  }

  /**
   * lock を尊重して取得する。取得済みで新しい branch と、いま取得中の branch は除く。
   * `dir` は対象 repo 配下の任意 worktree path（PR は repo 単位で結果同一）。
   */
  function fetchIfDue(
    rootDir: string,
    dir: string,
    branches: string[],
    opts: { now?: number } = {},
  ): void {
    const running = inFlight.get(rootDir);
    const stale = staleBranches({
      entries: cacheByRepo.value.get(rootDir),
      branches,
      now: opts.now ?? Date.now(),
    }).filter((branch) => running?.has(branch) !== true);
    if (stale.length === 0) {
      logEvent("pr-badge", "skip", repoName(rootDir));
      return;
    }
    runFetch(rootDir, dir, stale);
  }

  return { prByBranch, fetchIfDue };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrBadgeStore, import.meta.hot));
}
