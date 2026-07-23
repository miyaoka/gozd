import type { TextSearchLineResult, TextSearchMatchPush } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { watchDebounced } from "@vueuse/core";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { useWorktreeStore } from "../worktree";
import { expandFilterGlobs } from "./expandFilterGlobs";
import { rpcTextSearch, rpcTextSearchCancel } from "./rpc";

/** ファイル単位に束ねた検索結果。lines は rg のファイル内順序（match / context 混在）。 */
export interface SearchFileGroup {
  path: string;
  lines: TextSearchLineResult[];
}

/** ストリーム中に UI へ反映する最小間隔（ms）。push 多発を数回の再描画に畳む。 */
const FLUSH_INTERVAL_MS = 100;

/**
 * 全文検索の SSOT。表示は file-picker と同じ中央 modal `<dialog>` 形式で、dialog の
 * open/close は SearchDialog.vue が native `<dialog>` を SSOT に持つ。本 store は「開け」を
 * `showSignal` の bump で伝え、検索条件・結果・実行ロジックを保持する。
 *
 * ## 性能設計（大規模 repo で必須）
 *
 * マッチは万単位で届く。deep reactive 配列に貯めると 1 件ごとに reactive proxy が作られ、
 * push のたびに全描画が走って数十秒かかる。これを避けるため:
 *
 * - 蓄積は **非リアクティブな raw 配列**（`rawGroups`）に対して行い、proxy を作らない
 * - UI へは `shallowRef`（`results`）で「配列参照ごと差し替え」て 1 回の再描画に畳む
 * - 反映は **FLUSH_INTERVAL_MS ごとに throttle** し、push 多発を数回の flush にまとめる
 * - 描画側（SearchDialog）は行数を上限でキャップして DOM 爆発を止める
 *
 * 検索は searchId で相関を取り、query / トグル変更のたびに前回検索を cancel して rg を
 * 張り直す。マッチ push は store 生成時に一度だけ購読し、現行 searchId 分だけ取り込む。
 */
export const useSearchStore = defineStore("search", () => {
  const worktreeStore = useWorktreeStore();
  const notify = useNotificationStore();

  // dialog を開く要求。command が bump し、SearchDialog が showModal + 入力 focus する
  const showSignal = ref(0);
  function show(): void {
    showSignal.value++;
  }

  // --- 検索条件 ---
  const query = ref("");
  const isRegExp = ref(false);
  const isCaseSensitive = ref(false);
  const isWordMatch = ref(false);
  /** files to include / exclude 入力欄の生テキスト（カンマ区切り glob）。 */
  const includeText = ref("");
  const excludeText = ref("");

  /**
   * regex モードで不正な正規表現を打ったときのエラーメッセージ（VS Code の
   * `searchWidget.validateSearchInput` 相当）。rg に投げる前に client 側で `new RegExp` 検証し、
   * 失敗なら検索せずメッセージを出す（rg 失敗を「No results」と誤表示しないため）。
   * JS と rg で regex 方言は完全一致しないが、VS Code 同様の近似 client 検証とする。
   */
  const regexError = computed<string | undefined>(() => {
    if (!isRegExp.value || query.value === "") return undefined;
    const result = tryCatch(() => new RegExp(query.value, "u"));
    return result.ok ? undefined : (result.error as Error).message;
  });

  // --- 検索結果（UI 反映用の shallow view） ---
  const results = shallowRef<SearchFileGroup[]>([]);
  const running = ref(false);
  const limitHit = ref(false);
  const matchCount = ref(0);
  const fileCount = ref(0);

  // --- 非リアクティブな蓄積（proxy を作らない）---
  let rawGroups: SearchFileGroup[] = [];
  let groupIndex = new Map<string, number>();
  let rawMatchCount = 0;

  /** 現行検索の相関キー。stale push を捨てる基準。 */
  let currentSearchId: string | undefined;
  let seq = 0;

  /** throttle flush のスケジュール済みタイマー。 */
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** raw 蓄積を shallow view へ反映する（参照差し替えで 1 回の再描画）。 */
  function flush(): void {
    // 配列参照を新しくして shallowRef の変更を確定させる
    results.value = rawGroups.slice();
    matchCount.value = rawMatchCount;
    fileCount.value = rawGroups.length;
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  function reset(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    rawGroups = [];
    groupIndex = new Map();
    rawMatchCount = 0;
    results.value = [];
    matchCount.value = 0;
    fileCount.value = 0;
    limitHit.value = false;
  }

  /**
   * dialog を閉じたときに呼ぶ。入力・結果を初期化し、進行中の検索を止める。
   * 「次回まっさらで開く」ための UX リセット。worktree スコープの正しさ（表示中の結果が
   * 常に現 active worktree のもの）は dir watch（後述）が別途担保する。
   * トグル（case / word / regex）は検索の好みなので保持する。
   */
  function clear(): void {
    cancelCurrent();
    reset();
    query.value = "";
    includeText.value = "";
    excludeText.value = "";
  }

  /** 現行検索を止める（rg を kill）。 */
  function cancelCurrent(): void {
    if (currentSearchId === undefined) return;
    const id = currentSearchId;
    currentSearchId = undefined;
    running.value = false;
    // fire-and-forget だが silent drop は避ける（1 度の取りこぼしで rg が残る）
    void tryCatch(rpcTextSearchCancel({ searchId: id })).then((result) => {
      if (!result.ok) notify.debug("[cancelCurrent] rpcTextSearchCancel failed", result.error);
    });
  }

  /** 現在の条件で検索を実行する。空クエリなら結果クリアのみ。 */
  async function runSearch(): Promise<void> {
    cancelCurrent();
    reset();

    const dir = worktreeStore.dir;
    const pattern = query.value;
    // 不正 regex は rg に投げず、エラー表示（regexError）だけ出して検索しない
    if (dir === undefined || pattern === "" || regexError.value !== undefined) {
      running.value = false;
      return;
    }

    const searchId = `search-${++seq}`;
    currentSearchId = searchId;
    running.value = true;

    const result = await tryCatch(
      rpcTextSearch({
        searchId,
        dir,
        query: {
          pattern,
          isRegExp: isRegExp.value,
          isCaseSensitive: isCaseSensitive.value,
          isWordMatch: isWordMatch.value,
        },
        options: {
          includes: expandFilterGlobs(includeText.value),
          excludes: expandFilterGlobs(excludeText.value),
          surroundingContext: 1,
        },
      }),
    );

    // 終端信号。開始後に別検索へ差し替わっていたら stale なので無視する
    if (currentSearchId !== searchId) return;
    running.value = false;
    currentSearchId = undefined;
    if (!result.ok) {
      // RPC 失敗（main の handler が throw 等）を握りつぶさず通知する
      notify.error("Search failed", result.error);
      return;
    }
    limitHit.value = result.value.limitHit;
    // 取りこぼしなく最終状態を反映する
    flush();
  }

  // active worktree が変わったら表示中の結果は別 repo のものになる。進行中検索を止めて
  // 結果を捨て、「表示中の結果は常に現 active worktree のもの」を構造的に保証する。
  // modal 中でも command palette 経由（reviveSession → worktreeStore.setOpen）で dir は
  // 切り替わり得るため、close クリアだけでは stale を防げない。
  watch(
    () => worktreeStore.dir,
    () => {
      cancelCurrent();
      reset();
    },
  );

  // 検索条件の変化で自動再検索。連続入力を 200ms coalesce して rg spawn を間引く
  watchDebounced(
    [query, isRegExp, isCaseSensitive, isWordMatch, includeText, excludeText],
    () => {
      void runSearch();
    },
    { debounce: 200 },
  );

  // textSearchMatch push を一度だけ購読。現行 searchId のマッチだけ raw に蓄積する
  onMessage<TextSearchMatchPush>("textSearchMatch", (payload) => {
    if (payload.searchId !== currentSearchId) return;
    for (const line of payload.lines) {
      let idx = groupIndex.get(line.path);
      if (idx === undefined) {
        idx = rawGroups.length;
        groupIndex.set(line.path, idx);
        rawGroups.push({ path: line.path, lines: [] });
      }
      rawGroups[idx].lines.push(line);
      rawMatchCount += line.ranges.length;
    }
    scheduleFlush();
  });

  return {
    showSignal,
    show,
    clear,
    query,
    isRegExp,
    isCaseSensitive,
    isWordMatch,
    includeText,
    excludeText,
    regexError,
    results,
    running,
    limitHit,
    matchCount,
    fileCount,
    runSearch,
    cancelCurrent,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSearchStore, import.meta.hot));
}
