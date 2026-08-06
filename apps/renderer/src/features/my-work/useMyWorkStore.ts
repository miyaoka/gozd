import type { GitMyWorkGroup } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { logEvent } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { ghErrorMessage } from "../palette";
import { rpcGitMyWork } from "./rpc";

/**
 * my work（認証ユーザー単位の PR / issue 一覧）の SSOT + 取得マネージャ + パネル開閉。
 *
 * ## なぜ repo 単位キャッシュを持たないか
 *
 * `usePrListStore` は repo をキーにキャッシュするが、こちらの取得単位は **認証ユーザー**で、
 * repo をまたいだ 1 つの結果しか存在しない。キーが 1 つなのでキャッシュはスカラで足り、
 * repo 切替や worktree 切替では何も起きない。
 *
 * ## 取得のかかり方
 *
 * `fetchIfDue` は freshness lock（60 秒）だけを見る純粋な入口で、いつ呼ぶかは呼び出し側
 * （MyWorkPanel）が「対象の出入り」として持つ。これにより、
 *
 * - パネルを開いた瞬間: lock を抜けていれば即時取得、抜けていなければキャッシュ表示のまま
 * - 開いている間: 60 秒間隔で再取得
 *
 * の両方が 1 つの入口で成り立つ。`usePrListStore` と同じ規律で、focus 専用の発火トリガは
 * 持たない（blur は「対象が消える」ものとして呼び出し側が扱う）。
 *
 * ## 取れなかったことを画面に残す
 *
 * 取得失敗でキャッシュは消さない。空にすると「作業が無い」と「取れなかった」が画面上で
 * 区別できなくなる。
 *
 * トーストは流れて消えるため、それだけでは失敗が画面から失われる。最後の取得の帰結を
 * `lastError` として保持し、パネルが 3 状態（未取得で取得中 / 未取得で失敗 / 取得済み）
 * を描けるようにする。キャッシュがある状態の失敗は stale として描く材料になる。
 */

/** 成否を問わずこの間は再取得しない (freshness lock)。polling interval と同値。 */
export const MY_WORK_FRESH_MS = 60_000;

/** 失敗の見出し。トーストとパネル内表示が同じ文言を指すよう 1 箇所に置く。 */
const FETCH_FAILED_MESSAGE = "Failed to load my work";

/**
 * 「いま取得すべきか」を決める純関数。lock (`allowedAt`) が未来なら抑制期間中。
 * `isPrListFetchDue` と同型（対象の選定は呼び出し側が持ち、これは lock だけ見る）。
 */
export function isMyWorkFetchDue(args: { allowedAt: number | undefined; now: number }): boolean {
  const { allowedAt, now } = args;
  return allowedAt === undefined || now >= allowedAt;
}

export const useMyWorkStore = defineStore("myWork", () => {
  const notify = useNotificationStore();

  const isOpen = ref(false);

  // 初回取得までの place holder。`webUrl` はこの時点では未知だが、パネルは取得が
  // 済むまで一覧を描かないため表示に出ない。軸ごとに別オブジェクトを作る
  const emptyGroup = (): GitMyWorkGroup => ({ items: [], totalCount: 0, webUrl: "" });
  const reviewRequestedPrs = ref<GitMyWorkGroup>(emptyGroup());
  const authoredPrs = ref<GitMyWorkGroup>(emptyGroup());
  const authoredIssues = ref<GitMyWorkGroup>(emptyGroup());

  /** 一度でも取得が成功したか。初回ロード中と「作業が 1 件も無い」の区別に使う。 */
  const hasLoaded = ref(false);
  const isLoading = ref(false);
  /** 最後の取得が失敗していればその文言。成功すると undefined に戻る。 */
  const lastError = ref<string | undefined>();

  /** この時刻まで再取得を抑制する deadline (ms epoch) */
  let nextAllowedAt: number | undefined;
  /** in-flight な取得 (並列発射の dedup) */
  let inFlight: Promise<void> | undefined;

  /** 観察ログ用の取得件数。表示件数であって総件数ではない */
  const loadedCount = computed(
    () =>
      reviewRequestedPrs.value.items.length +
      authoredPrs.value.items.length +
      authoredIssues.value.items.length,
  );

  function runFetch(): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    logEvent("my-work", "fire");
    isLoading.value = true;
    const promise = (async () => {
      try {
        const result = await tryCatch(rpcGitMyWork({}));
        if (!result.ok) {
          logEvent("my-work", "error", "", "rpc failed");
          lastError.value = FETCH_FAILED_MESSAGE;
          notify.error(FETCH_FAILED_MESSAGE, result.error);
          return;
        }
        const res = result.value;
        if (!res.ok) {
          logEvent("my-work", "error", "", res.errorKind);
          const message = ghErrorMessage(res.errorKind, FETCH_FAILED_MESSAGE);
          lastError.value = message;
          notify.error(message, res.errorDetail || undefined);
          // URL は取得の成否に依存しない静的な導出物。失敗応答からも取り込み、一覧が
          // 出せない間も GitHub 側で確認する導線を残す（件数と行はキャッシュを保つ）
          reviewRequestedPrs.value = {
            ...reviewRequestedPrs.value,
            webUrl: res.reviewRequestedPrs.webUrl,
          };
          authoredPrs.value = { ...authoredPrs.value, webUrl: res.authoredPrs.webUrl };
          authoredIssues.value = { ...authoredIssues.value, webUrl: res.authoredIssues.webUrl };
          return;
        }
        reviewRequestedPrs.value = res.reviewRequestedPrs;
        authoredPrs.value = res.authoredPrs;
        authoredIssues.value = res.authoredIssues;
        hasLoaded.value = true;
        lastError.value = undefined;
        logEvent("my-work", "done", "", `${loadedCount.value} items`);
      } finally {
        // lock は成否問わず張る（GitHub 障害中に開閉を繰り返しても撃ち続けないため）
        nextAllowedAt = Date.now() + MY_WORK_FRESH_MS;
        isLoading.value = false;
      }
    })();
    inFlight = promise;
    void promise.finally(() => {
      inFlight = undefined;
    });
    return promise;
  }

  /** freshness lock を尊重して取得する。lock 期間中 / in-flight は no-op（キャッシュのまま）。 */
  function fetchIfDue(opts: { now?: number } = {}): void {
    if (inFlight !== undefined) return;
    if (!isMyWorkFetchDue({ allowedAt: nextAllowedAt, now: opts.now ?? Date.now() })) {
      logEvent("my-work", "skip");
      return;
    }
    void runFetch();
  }

  /** ユーザーの明示操作による再取得。lock を無視して撃つ。 */
  function refresh(): void {
    void runFetch();
  }

  function open(): void {
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
  }
  function toggle(): void {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  return {
    isOpen,
    reviewRequestedPrs,
    authoredPrs,
    authoredIssues,
    hasLoaded,
    isLoading,
    lastError,
    fetchIfDue,
    refresh,
    open,
    close,
    toggle,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMyWorkStore, import.meta.hot));
}
