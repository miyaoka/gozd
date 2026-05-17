/**
 * active repo の `git fetch --all` を背景で回す app-scope な watcher。
 *
 * 設計方針:
 *
 * - **scope は active repo の rootDir 単位**。同 repo 内の worktree は `refs/remotes/*` を
 *   common git dir で共有するため、1 fetch で全 worktree の ahead/behind が更新される。
 *   worktree 単位 fan-out は network コストと credential 消費が無駄に倍化する
 * - **`git fetch --all`** を使う。upstream が origin 以外 (fork PR workflow で
 *   upstream=upstream / origin=fork) でも全 remote を更新できる。VSCode autofetch の
 *   `"all"` モード相当
 * - **ウィンドウ focus + 3 分間隔** (VSCode 既定 180s と同じ)。focus を失っている間は
 *   fetch を回さない。focus 復帰直後は閾値を無視して 1 発射する (blur 中の経過時間で
 *   debounce が誤判定するため、focus false→true 遷移で `lastFetchedAt` を消す)
 * - **成功時は 180s lock、失敗時は 30s 短 backoff**。起動直後の SSH agent unlock 前
 *   ヒット等の transient 失敗が「次の 180 秒間 fetch しない」状態を作らないため、
 *   失敗は短い backoff にする
 * - **repo 切替時の発射は初回のみ**。`lastFetchedAt` 未設定の repo を初めて開いた
 *   ときだけ即時 fetch する。A↔B 往復のたびに fetch を炊くと credential 消費が無駄
 * - **in-flight ロック**で同 repo 並列発射を抑止。RPC 遅延時に重複 fetch を防ぐ
 * - **失敗は console.warn に 1 行残す**。toast は出さない (通知爆発防止) が、
 *   開発者ツールから連続失敗 / errorDetail を観察できる経路は確保する
 *
 * 後段は既存パイプに乗る: fetch が成功すると `refs/remotes/<remote>/*` が書き換わり、
 * FSWatchRegistry が gitStatusFull を再実行して `gitStatusChange` push を発射する。
 * renderer 側は `useGitStatusSync` が repoStore に書き戻し、WtCard の ahead/behind が更新される。
 */
import { tryCatch } from "@gozd/shared";
import { useWindowFocus } from "@vueuse/core";
import { onUnmounted, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { rpcGitFetchRemotes } from "./rpc";

/** 成功時の lock 期間 (ms)。VSCode の `git.autofetchPeriod` 既定値 180s と同じ */
const SUCCESS_INTERVAL_MS = 180_000;
/** 失敗時の短 backoff (ms)。起動直後の SSH unlock 待ち / 一時的 offline からの回復を捕捉する */
const FAILURE_BACKOFF_MS = 30_000;

export function useRemoteFetchSync() {
  const repoStore = useRepoStore();
  const focused = useWindowFocus();

  /** rootDir → 「この時刻まで次の fetch を抑制」する deadline (ms epoch) */
  const nextFetchAllowedAt = new Map<string, number>();
  /** rootDir → 現在 in-flight な fetch の有無 */
  const inFlight = new Set<string>();

  /**
   * 1 repo を fetch する。focus 喪失 / backoff 期間中 / in-flight なら no-op。
   * 成功なら 180s、失敗なら 30s 後まで再試行を抑制する。
   */
  async function fetchOnceIfDue(rootDir: string) {
    if (!focused.value) return;
    if (inFlight.has(rootDir)) return;
    const allowedAt = nextFetchAllowedAt.get(rootDir);
    if (allowedAt !== undefined && Date.now() < allowedAt) return;
    // git 管理外の project は fetch 対象外
    const repo = repoStore.repos[rootDir];
    if (repo === undefined || !repo.isGitRepo) return;

    inFlight.add(rootDir);
    const result = await tryCatch(rpcGitFetchRemotes({ dir: rootDir }));
    inFlight.delete(rootDir);

    const now = Date.now();
    if (!result.ok) {
      // RPC 層の失敗 (transport error 等)。短 backoff してリトライ可能にする
      console.warn("[useRemoteFetchSync] RPC failed", { rootDir, error: result.error });
      nextFetchAllowedAt.set(rootDir, now + FAILURE_BACKOFF_MS);
      return;
    }
    if (!result.value.ok) {
      // RPC は成功したが git fetch が失敗 (offline / 認証失敗 / remote 未設定)。
      // errorDetail を log に残し、短 backoff で次サイクルに任せる
      console.warn("[useRemoteFetchSync] git fetch failed", {
        rootDir,
        errorDetail: result.value.errorDetail,
      });
      nextFetchAllowedAt.set(rootDir, now + FAILURE_BACKOFF_MS);
      return;
    }
    nextFetchAllowedAt.set(rootDir, now + SUCCESS_INTERVAL_MS);
  }

  /** active repo を fetch (閾値判定込み) */
  function fetchActive() {
    const rootDir = repoStore.selectedRootDir;
    if (rootDir === undefined) return;
    void fetchOnceIfDue(rootDir);
  }

  // active repo 切替時の発射は「その repo を初めて見たとき」だけにする。
  // 既に一度 fetch している repo に戻ったときは閾値判定に任せ、A↔B 往復で都度
  // fetch を炊かない。これにより VSCode 互換の interval 主導動作になる。
  watch(
    () => repoStore.selectedRootDir,
    (rootDir) => {
      if (rootDir === undefined) return;
      if (nextFetchAllowedAt.has(rootDir)) return;
      void fetchOnceIfDue(rootDir);
    },
    { immediate: true },
  );

  // focus 復帰 (blur → focus) で active repo の deadline を消して即発射する。
  // blur 中も時計は進むため、deadline ベースで判定すると「focus は戻ったが残り 179s」
  // のケースで behind 反映が最悪 3 分待たされる。focus 遷移自体をトリガにすれば
  // ユーザーが UI に戻ってきたタイミングで必ず最新化される。
  watch(focused, (isFocused, wasFocused) => {
    if (!isFocused || wasFocused === true) return;
    const rootDir = repoStore.selectedRootDir;
    if (rootDir === undefined) return;
    nextFetchAllowedAt.delete(rootDir);
    void fetchOnceIfDue(rootDir);
  });

  // 180s インターバル: focus 中は閾値判定に従って fetch、focus 喪失中は早期 return。
  // タイマー自体は走らせ続けて問題ない (timer cost は無視できる)。
  const intervalId = setInterval(fetchActive, SUCCESS_INTERVAL_MS);

  onUnmounted(() => {
    clearInterval(intervalId);
  });
}
