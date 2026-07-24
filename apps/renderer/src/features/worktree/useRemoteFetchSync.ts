/**
 * 背景 `git fetch --all` の対象 repo と発火タイミングを一元管理する app-scope な watcher。
 *
 * ## 対象スコープ = active repo ∪ 画面に写っている repo
 *
 * fetch する repo は「いま ahead/behind を見せる意味がある repo」だけに絞る:
 *
 * - **active repo**: ユーザーが作業中の worktree の repo。サイドバーで畳まれていても
 *   スクロール外でも、GitGraph 等が最新の ahead/behind を要るので常に対象
 * - **画面に写っている repo**: サイドバーの viewport 内に展開表示されている repo
 *   (`RepoSection` が IntersectionObserver で `repoStore.setRepoOnScreen` に報告)。
 *   カードの ahead/behind バッジを最新化するため。畳まれている / スクロール外の repo は
 *   見えないので対象外
 *
 * これにより「登録されているが今は見ていない repo」(別 repo list の repo 等) への背景 fetch を
 * やめる。従来 focus 復帰のたびに全 repo list union を fan-out していた退行を断つ
 * (flaky な回線で見てもいない repo の 75s connect hang → 永続トーストが量産されていた)。
 *
 * ## トリガ
 *
 * - **対象集合の出入り** (wt 切替 / scroll / 展開・折りたたみ) は debounce して、新規に対象へ
 *   入った repo を即 fetch する。連打 (wt を素早く切り替える等) は debounce で coalesce される
 * - **定期 poll** で対象 repo を再取得する。tick は失敗 backoff 粒度 (30s)。成功 repo は 180s
 *   lock で skip され、失敗 repo は次 tick で retry される (発火判定は store の `isRepoFetchDue`)
 *
 * focus は一切トリガにしない。window focus は作業中に細かく揺れる高頻度イベントで、そこに
 * network fan-out を紐付けると focus が揺れるたびに全対象を再 fetch してしまうため。
 *
 * in-flight ロック / backoff / 同時実行 cap / 非 git 判定はすべて `useRemoteFetchStore` に
 * 閉じる。本 composable は「どの repo をいつ」だけを持つ。
 *
 * 後段は既存パイプに乗る: fetch が成功すると `refs/remotes/<remote>/*` が書き換わり、
 * FSWatchRegistry が gitStatusFull を再実行して `gitStatusChange` push を発射する。
 */
import { useDebounceFn } from "@vueuse/core";
import { computed, onUnmounted, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import {
  REMOTE_FETCH_FAILURE_BACKOFF_MS as POLL_INTERVAL_MS,
  useRemoteFetchStore,
} from "./useRemoteFetchStore";

/** 対象集合の churn (wt 切替 / scroll / 展開) を coalesce する debounce (ms) */
const MEMBERSHIP_DEBOUNCE_MS = 300;

export function useRemoteFetchSync() {
  const repoStore = useRepoStore();
  const fetchStore = useRemoteFetchStore();

  // 背景 fetch の対象 = 画面に写っている repo ∪ active repo。
  const targetRoots = computed(() => {
    const set = new Set(repoStore.onScreenRoots);
    const active = repoStore.selectedRootDir;
    if (active !== undefined) set.add(active);
    return set;
  });

  // 対象 repo を due gate 越しに fetch する。fetchIfDue が per-repo の lock/backoff/in-flight を
  // 見るため、lock 中の repo は no-op になる (毎 tick 呼んでも実 fetch は発火しない)。
  function fetchTargets() {
    for (const rootDir of targetRoots.value) void fetchStore.fetchIfDue(rootDir);
  }

  // 対象集合が変わったら debounce して新規 repo を即 fetch (連打は coalesce)。
  const fetchTargetsDebounced = useDebounceFn(fetchTargets, MEMBERSHIP_DEBOUNCE_MS);
  watch(targetRoots, fetchTargetsDebounced, { immediate: true });

  // 定期 poll。tick は失敗 backoff 粒度に合わせ、成功 repo は skip・失敗 repo は retry される。
  const intervalId = setInterval(fetchTargets, POLL_INTERVAL_MS);
  onUnmounted(() => clearInterval(intervalId));
}
