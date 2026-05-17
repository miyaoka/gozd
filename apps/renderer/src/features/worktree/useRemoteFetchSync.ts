/**
 * active repo の `git fetch origin` を背景で回す app-scope な watcher。
 *
 * 設計方針:
 *
 * - **scope は active repo の rootDir 単位**。同 repo 内の worktree は `refs/remotes/*` を
 *   common git dir で共有するため、1 fetch で全 worktree の ahead/behind が更新される。
 *   worktree 単位 fan-out は network コストと credential 消費が無駄に倍化する
 * - **ウィンドウ focus + 3 分間隔** (VSCode 既定 180s と同じ)。focus を失っている間は
 *   fetch を回さない。焦点が戻った時点で「最後の fetch から 3 分以上経過」を満たせば
 *   即座に 1 発射し、以降タイマー再開
 * - **直近 fetch 時刻 (`lastFetchedAt`) で debounce**。focus 切替を頻繁に行う UI でも
 *   3 分閾値を満たさない限り fetch しない
 * - **in-flight ロック**で同 repo 並列発射を抑止。RPC が遅延した場合に重複 fetch を
 *   起こさない
 * - **失敗は静かに飲み込む**。offline / 認証失敗 / origin 未設定は通知しない。
 *   通知爆発を防ぐためで、debug は native 側 stderr / error_detail に残る
 *
 * 後段は既存パイプに乗る: fetch が成功すると `refs/remotes/origin/*` が書き換わり、
 * FSWatchRegistry が gitStatusFull を再実行して `gitStatusChange` push を発射する。
 * renderer 側は `useGitStatusSync` が repoStore に書き戻し、WtCard の ahead/behind が更新される。
 */
import { tryCatch } from "@gozd/shared";
import { useWindowFocus } from "@vueuse/core";
import { onUnmounted, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { rpcGitFetchOrigin } from "./rpc";

/** fetch 間隔 (ms)。VSCode の `git.autofetchPeriod` 既定値 180s と同じ */
const FETCH_INTERVAL_MS = 180_000;

export function useRemoteFetchSync() {
  const repoStore = useRepoStore();
  const focused = useWindowFocus();

  /** rootDir → 最後に fetch が完了 (成功 / 失敗どちらでも) した時刻 (ms epoch) */
  const lastFetchedAt = new Map<string, number>();
  /** rootDir → 現在 in-flight な fetch の有無 */
  const inFlight = new Set<string>();

  /**
   * 1 repo を fetch する。focus 喪失 / 直近 fetch から閾値未満 / in-flight なら no-op。
   * fetch 自体は ok=false で返ってきても通知せず lastFetchedAt を進める (リトライ抑制)。
   */
  async function fetchOnceIfDue(rootDir: string) {
    if (!focused.value) return;
    if (inFlight.has(rootDir)) return;
    const last = lastFetchedAt.get(rootDir);
    if (last !== undefined && Date.now() - last < FETCH_INTERVAL_MS) return;
    // git 管理外の project は fetch 対象外
    const repo = repoStore.repos[rootDir];
    if (repo === undefined || !repo.isGitRepo) return;

    inFlight.add(rootDir);
    try {
      await tryCatch(rpcGitFetchOrigin({ dir: rootDir }));
      // ok=false (offline / 認証失敗等) も lastFetchedAt を進める。次の 3 分は再試行しない
      lastFetchedAt.set(rootDir, Date.now());
    } finally {
      inFlight.delete(rootDir);
    }
  }

  /** active repo を即時 fetch (閾値判定込み) */
  function fetchActive() {
    const rootDir = repoStore.selectedRootDir;
    if (rootDir === undefined) return;
    void fetchOnceIfDue(rootDir);
  }

  // active repo 切替 + focus 回復 + 起動直後の各タイミングで fetch を試みる。
  // immediate: true で初回 fetch をカバー (lastFetchedAt 未設定なら即実行)。
  watch([() => repoStore.selectedRootDir, focused], fetchActive, { immediate: true });

  // 3 分インターバルでも回す。focus 喪失中は fetchOnceIfDue が早期 return するので
  // タイマー自体は走らせ続けて問題ない (timer cost は無視できる)。
  const intervalId = setInterval(fetchActive, FETCH_INTERVAL_MS);

  onUnmounted(() => {
    clearInterval(intervalId);
  });
}
