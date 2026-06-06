import type { GitPullRequest } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRemoteFetchStore, useWorktreeStore } from "../worktree";
import { rpcGitMergeBase, rpcGitRevReachable } from "./rpc";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrListStore } from "./usePrListStore";

/**
 * PR diff モード (ChangesPane / PreviewPane を「PR base..working tree」表示に切り替える) の SSOT。
 *
 * 既存の gitGraphStore 選択経路を一切上書きしない (= graph 側の見た目・state は不変)。
 * ChangesPane / PreviewPane / useChangesStore はこのストアの `isOn` / `lockedBaseOid` を見て
 * 表示ソースを分岐する。toggle ON 中も graph 側 selection はユーザーが触ったままの値で残る。
 *
 * ## 起点は merge-base (= GitHub Files changed と同じ 3-dot semantics)
 *
 * `lockedBaseOid` は GitHub の `baseRefOid` ではなく **`merge-base(HEAD, baseRefOid)`** を保持する。
 * `baseRefOid` を直接起点にすると、PR 分岐後に base ブランチが前進した分が逆向きに差分として
 * 混入する (= 「自分のブランチに含まれていない main の変更」が PR diff に紛れ込む bug。PR #704 で
 * これを誤認し PR #708 で merge-base に修正)。
 *
 * 3-dot **構文** (`<base>...<head>`) は両辺 commit を要求し working tree を含められないが、
 * **意味論** だけ取り出して merge-base OID を `git diff <merge-base>` (右辺省略 = working tree) の
 * 起点に据えれば、working tree 含有と 3-dot semantics を両立できる。
 *
 * ## state の SSOT は `lockedBase`
 *
 * - `enable()` 時に「現在の `baseRefOid`」を起点に reachable 判定 → fetch (必要なら) → merge-base 計算
 *   を行い、`{ sourceBaseOid: baseRefOid snapshot, diffBaseOid: merge-base OID }` を保持する
 * - `isOn` / `disable` は `lockedBase` の有無 / クリアとして表現する (派生)
 * - 表示用 / per-file 取得用の起点 OID は **`diffBaseOid` (= merge-base)**。consumer は公開 getter
 *   `lockedBaseOid` 経由で読む (実体は `lockedBase.diffBaseOid`)
 * - auto-off の比較対象は **`sourceBaseOid` (= baseRefOid snapshot)**。live `baseRefOid` がこの
 *   snapshot と変われば「PR base 端が動いた」とみなして auto-off する
 *
 * ## enable() を async にした race 対策
 *
 * reachable / fetch / merge-base の 3 段チェーンは数秒オーダーになりうる。await 中に
 * - toggle がもう一度押された (= disable / 再 enable)
 * - worktree が切り替わった
 * - live `baseRefOid` が変わった
 * のいずれかが起きると snapshot 結果は破棄する。`enableSeq` 単一カウンタを比較して破棄判定する。
 *
 * ## 自動 OFF 経路
 *
 * - ユーザーが graph で commit を select / selectCompare した瞬間 (`selectionVersion` の increment)
 * - 現在 branch の PR が `usePrListStore` から消えた / `baseRefOid` が snapshot と変わった
 *
 * いずれも silent drop 禁止規律に従い、`useNotificationStore.info` でユーザーにトースト通知する
 * (toggle の見た目が突然変わるのでユーザーに認知させる必要がある)。
 */
export const usePrDiffToggleStore = defineStore("prDiffToggle", () => {
  const gitGraphStore = useGitGraphStore();
  const prListStore = usePrListStore();
  const worktreeStore = useWorktreeStore();
  const fetchStore = useRemoteFetchStore();
  const notify = useNotificationStore();

  /** ON 時に snapshot された 2 つの OID のペア。undefined のとき OFF (== `isOn=false`)。
   *
   * - `sourceBaseOid`: enable 時の live `baseRefOid`。auto-off 判定で live 値と比較する
   * - `diffBaseOid`: `merge-base(HEAD, sourceBaseOid)`。diff / per-file 取得の起点 */
  const lockedBase = ref<{ sourceBaseOid: string; diffBaseOid: string } | undefined>(undefined);

  /** PR diff モードが ON か。`lockedBase` の有無で一意に決まる派生値。 */
  const isOn = computed(() => lockedBase.value !== undefined);

  /** 現在 branch (HEAD が指すブランチ) の PR。無ければ undefined。 */
  const pr = computed<GitPullRequest | undefined>(() => {
    const branch = gitGraphStore.currentBranch;
    if (branch === undefined) return undefined;
    return prListStore.prByBranch.get(branch);
  });

  /** 現在 branch の PR の **live** base commit OID (= `baseRefOid`)。enable() の起点 / auto-off の
   * 比較対象に使う。`base_ref_oid` は GitHub GraphQL の `baseRefOid` を SSOT として持つ。 */
  const baseOid = computed<string | undefined>(() => {
    const value = pr.value;
    if (value === undefined) return undefined;
    if (value.baseRefOid === "") return undefined;
    return value.baseRefOid;
  });

  /** toggle ON が成立しうるか (PR が見つかり、base OID が解決できているか)。
   * merge-base 計算は `enable()` 実行時に行うため、ここでは live `baseRefOid` の有無のみ判定する。 */
  const canEnable = computed(() => baseOid.value !== undefined);

  /** consumer (useChangesStore / PreviewPane / ChangesSummaryItem) が読む起点 OID。
   * **merge-base OID** (= `lockedBase.diffBaseOid`)。OFF 時 undefined。 */
  const lockedBaseOid = computed<string | undefined>(() => lockedBase.value?.diffBaseOid);

  /** enable() を async 化したことによる race を破棄するための単調 increment counter。
   * disable() / 連続 enable() / auto-off 経由 disable() でも increment され、進行中の
   * enable() は post-await の `seq !== enableSeq.value` チェックで結果を捨てる。 */
  const enableSeq = ref(0);
  /** enable() async の進行中フラグ。ChangesPane の toggle button の loading 表示等に使える。 */
  const enabling = ref(false);

  async function enable() {
    if (isOn.value) return;
    const initialBaseOid = baseOid.value;
    if (initialBaseOid === undefined) return;
    const initialDir = worktreeStore.dir;
    if (initialDir === undefined) return;

    const seq = ++enableSeq.value;
    enabling.value = true;
    try {
      // 1. reachable 判定: baseRefOid が local repo に届いているか
      const reachable = await tryCatch(
        rpcGitRevReachable({ dir: initialDir, hash: initialBaseOid }),
      );
      if (seq !== enableSeq.value) return;
      if (!reachable.ok) {
        notify.error("Failed to probe PR diff base reachability", reachable.error);
        return;
      }

      // 2. 未 reachable なら fetch を要求 (背景 fetch の backoff を bypass)
      if (!reachable.value.reachable) {
        const fetched = await fetchStore.requestImmediateFetch(initialDir);
        if (seq !== enableSeq.value) return;
        if (!fetched) {
          // 下層 (`useRemoteFetchStore`) で notify.info が出ている契約。追加通知は出さない。
          return;
        }
      }

      // 3. merge-base 計算 (= 3-dot semantics の左端解決)
      const merged = await tryCatch(
        rpcGitMergeBase({ dir: initialDir, hash1: "HEAD", hash2: initialBaseOid }),
      );
      if (seq !== enableSeq.value) return;
      if (!merged.ok) {
        notify.error("Failed to compute PR diff merge-base", merged.error);
        return;
      }
      const mergeBaseOid = merged.value.mergeBaseOid;
      if (mergeBaseOid === "") {
        // GitOps.mergeBase が空文字を返すのは unrelated histories / hash 不在 / validateRev 失敗。
        // どれも diff の起点が決まらないため enable しない。
        notify.error("PR diff: cannot resolve merge-base with PR base (unrelated histories?)");
        return;
      }

      // 4. final race check: await 中に live `baseRefOid` が変わっていないか
      if (initialBaseOid !== baseOid.value) return;

      lockedBase.value = { sourceBaseOid: initialBaseOid, diffBaseOid: mergeBaseOid };
    } finally {
      if (seq === enableSeq.value) enabling.value = false;
    }
  }

  function disable() {
    // 進行中の enable() を破棄するため increment
    enableSeq.value++;
    enabling.value = false;
    lockedBase.value = undefined;
  }

  async function toggle() {
    if (isOn.value || enabling.value) {
      disable();
    } else {
      await enable();
    }
  }

  // ユーザーが graph で commit を select したら toggle を OFF する。
  // `selectionVersion` は select() / selectCompare() のみで increment される SSOT。
  watch(
    () => gitGraphStore.selectionVersion,
    () => {
      if (!isOn.value && !enabling.value) return;
      disable();
      notify.info("PR diff turned off: git-graph selection changed");
    },
  );

  // live `baseRefOid` を snapshot (`sourceBaseOid`) と比較し、消失 / 変化のいずれかで auto-off。
  // ON 中のみ走らせる早期 return で OFF 状態の noise を抑制する (enable() 中も対象外: enable()
  // 自身が post-await チェックで race を処理する)。
  watch(
    () => baseOid.value,
    (current) => {
      const snapshot = lockedBase.value?.sourceBaseOid;
      if (snapshot === undefined) return;
      if (current === undefined) {
        disable();
        notify.info("PR diff turned off: pull request no longer available for current branch");
        return;
      }
      if (current !== snapshot) {
        disable();
        notify.info(`PR diff turned off: PR base commit changed from ${snapshot} to ${current}`);
      }
    },
  );

  return {
    isOn,
    enabling,
    pr,
    baseOid,
    lockedBaseOid,
    canEnable,
    enable,
    disable,
    toggle,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrDiffToggleStore, import.meta.hot));
}
