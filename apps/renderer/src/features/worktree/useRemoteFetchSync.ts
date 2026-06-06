/**
 * 登録 repo の `git fetch --all` を背景で回す app-scope な watcher。
 *
 * 設計方針:
 *
 * - **scope は repo の rootDir 単位**。同 repo 内の worktree は `refs/remotes/*` を
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
 * - **初回 fetch は登録されている全 repo を対象にする**。起動時に hydrate された repo も、
 *   後から開かれた repo も、それぞれ `nextFetchAllowedAt` 未設定のあいだ 1 回だけ即時
 *   fetch する。定期 interval / focus 復帰の発射は active repo に絞るが (定期 fan-out は
 *   rate limit 累積発火を招くため抑制する規律)、初回は polling ではなく repo 単位 1 回
 *   なので全 repo に広げても累積発火しない。A↔B 往復のたびに fetch を炊かないのは lock
 *   で保証する
 * - **in-flight ロック / backoff / 非 git project 判定**は `useRemoteFetchStore.fetchIfDue` に
 *   閉じる。本 composable は polling lifecycle (focus / interval / repo key watch) のみ担当し、
 *   gate 判定は store 側 1 箇所に集約する
 * - **失敗は `useNotificationStore.info` で通知**。プロジェクト規約「console.error で
 *   握り潰さない」に従う。連射抑制は 30s backoff で効くため、トースト爆発はしない
 *   (offline 等の継続的失敗でも 30s に 1 件)
 *
 * 後段は既存パイプに乗る: fetch が成功すると `refs/remotes/<remote>/*` が書き換わり、
 * FSWatchRegistry が gitStatusFull を再実行して `gitStatusChange` push を発射する。
 * renderer 側は `useGitStatusSync` が repoStore に書き戻し、WtCard の ahead/behind が更新される。
 */
import { useWindowFocus } from "@vueuse/core";
import { onUnmounted, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import {
  REMOTE_FETCH_SUCCESS_INTERVAL_MS as SUCCESS_INTERVAL_MS,
  useRemoteFetchStore,
} from "./useRemoteFetchStore";

export function useRemoteFetchSync() {
  const repoStore = useRepoStore();
  const focused = useWindowFocus();
  const fetchStore = useRemoteFetchStore();

  /** active repo を fetch (gate 判定込み、due でなければ no-op) */
  function fetchActive() {
    const rootDir = repoStore.selectedRootDir;
    if (rootDir === undefined) return;
    void fetchStore.fetchIfDue(rootDir, { focused: focused.value });
  }

  // 「初回 fetch は登録全 repo」の所有をこの 1 関数に集約する。focus 喪失中は store 側
  // `fetchIfDue` が due 判定で skip され lock も立たないため、focus 復帰経路から再度
  // この関数を呼べば取りこぼした repo を確実にリカバリできる。
  // 初回判定は「allowedAt 未設定 = 未 fetch」をユーザー側で読まず、`fetchIfDue` 内の
  // backoff チェックに含まれる (allowedAt undefined は backoff 期間外と判定される)。
  function fetchAllRepos() {
    for (const rootDir of Object.keys(repoStore.repos)) {
      void fetchStore.fetchIfDue(rootDir, { focused: focused.value });
    }
  }

  // 登録されている全 repo を対象に「初めて見た repo」を fetch する。起動時に hydrate
  // された repo 群も、後から開かれた repo も、それぞれ初回 1 回だけ即時 fetch が走る。
  // 既に一度 fetch した repo は `allowedAt` が立つため再発射しない (A↔B 往復で
  // 都度 fetch を炊かない)。以降は interval 主導の閾値判定に任せる。
  watch(() => Object.keys(repoStore.repos), fetchAllRepos, { immediate: true });

  // focus 復帰 (blur → focus) で 2 つを行う。
  // - active repo の deadline を消して即発射: blur 中も時計は進むため deadline ベース判定だと
  //   「focus は戻ったが残り 179s」で behind 反映が最悪 3 分待たされる。focus 遷移自体を
  //   トリガにすればユーザーが UI に戻ったタイミングで必ず最新化される。
  // - 未 fetch repo の初回 fetch をリカバリ: focus 無し起動だと repos key watch 発火時に
  //   全 repo が skip され lock も立たない。focus 復帰でここを通すことで取りこぼしを救う。
  watch(focused, (isFocused, wasFocused) => {
    if (!isFocused || wasFocused === true) return;
    const rootDir = repoStore.selectedRootDir;
    if (rootDir !== undefined) {
      fetchStore.clearAllowedAt(rootDir);
      void fetchStore.fetchIfDue(rootDir, { focused: true });
    }
    fetchAllRepos();
  });

  // 180s インターバル: focus 中は閾値判定に従って fetch、focus 喪失中は早期 return。
  // タイマー自体は走らせ続けて問題ない (timer cost は無視できる)。
  const intervalId = setInterval(fetchActive, SUCCESS_INTERVAL_MS);

  onUnmounted(() => {
    clearInterval(intervalId);
  });
}
