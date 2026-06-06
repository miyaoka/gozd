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
 * `lockedBaseOid` は `baseRefOid` ではなく **`merge-base(HEAD, baseRefOid)`** を保持する。
 * `baseRefOid` を直接起点にすると、PR 分岐後に base ブランチが前進した分が逆向きに差分として
 * 混入する (= 「自分のブランチに含まれていない main の変更」が PR diff に紛れ込む)。
 *
 * 3-dot **構文** (`<base>...<head>`) は両辺 commit を要求し working tree を含められないが、
 * **意味論** だけ取り出して merge-base OID を `git diff <merge-base>` (右辺省略 = working tree) の
 * 起点に据えれば、working tree 含有と 3-dot semantics を両立できる。
 *
 * ## state の SSOT は `lockedBase`
 *
 * - `enable()` 時に「現在の `baseRefOid`」を起点に reachable 判定 → fetch (必要なら) → 再 reachable
 *   判定 → merge-base 計算を行い、`{ sourceBaseOid: baseRefOid snapshot, diffBaseOid: merge-base OID }`
 *   を保持する
 * - `isOn` / `disable` は `lockedBase` の有無 / クリアとして表現する (派生)
 * - 表示用 / per-file 取得用の起点 OID は **`diffBaseOid` (= merge-base)**。consumer は公開 getter
 *   `lockedBaseOid` 経由で読む (実体は `lockedBase.diffBaseOid`)
 * - auto-off の比較対象は **`sourceBaseOid` (= baseRefOid snapshot)**。live `baseRefOid` がこの
 *   snapshot と変われば「PR base 端が動いた」とみなして auto-off する
 *
 * ## auto-off の一次トリガ
 *
 * - `worktreeStore.dir` の変化: enable() の起点入力が変わるため一次トリガ。`baseRefOid` 経由の
 *   間接判定だと「別 worktree の PR の `baseRefOid` が偶然同値」の場合に取りこぼすため、dir 変化は
 *   独立して watch する。enable() async 中の dir 切替もこの watcher が `enableSeq` を increment
 *   して破棄する (race 防護)
 * - `gitGraphStore.selectionVersion` の increment: ユーザーが graph で commit を選んだ瞬間
 * - live `baseRefOid` が `sourceBaseOid` snapshot と変化: PR base end が動いた / 消失
 *
 * いずれも silent drop 禁止規律に従い、`useNotificationStore.info` でユーザーにトースト通知する
 * (toggle の見た目が突然変わるのでユーザーに認知させる必要がある)。ただし enable() async 中で
 * `isOn=false` のままだった場合、toggle はまだ ON の視覚的フィードバックを出していないため、
 * graph selection 経由の disable は通知を出さない (`isOn` を判定条件にする)。
 *
 * ## enable() を async にした race 対策
 *
 * reachable / fetch / 再 reachable / merge-base の 4 段チェーンは数秒オーダーになりうる。
 * await 中に
 * - toggle がもう一度押された (= disable / 再 enable)
 * - worktree が切り替わった
 * - live `baseRefOid` が変わった
 * のいずれかが起きると snapshot 結果は破棄する。`enableSeq` 単一カウンタを比較して破棄判定する。
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
   * 比較対象に使う。 */
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

  /** enable() async race を破棄するための単調 increment counter。disable() / 連続 enable() /
   * auto-off 経由 disable() / dir 変化 / baseRefOid 変化 のいずれでも increment され、
   * 進行中の enable() は post-await の `seq !== enableSeq.value` チェックで結果を捨てる。 */
  const enableSeq = ref(0);
  /** enable() async の進行中フラグ。ChangesPane の toggle button の disabled gate に使う。
   * 書き込みは `enable()` の入口 (true) と finally (false) の 2 か所のみで、disable() からは
   * 書かない (= race トークン = enableSeq に所有を集約)。 */
  const enabling = ref(false);

  async function enable() {
    if (isOn.value || enabling.value) return;
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

      // 2. 未 reachable なら fetch を要求 → 再 reachable 判定。fetch 成功でもリモートで base ref が
      // 削除されていれば依然 unreachable のため、再判定で「fetch しても届かない」を構造的に検出する。
      if (!reachable.value.reachable) {
        const fetched = await fetchStore.requestImmediateFetch(initialDir);
        if (seq !== enableSeq.value) return;
        if (!fetched) {
          // 下層 (`useRemoteFetchStore`) で notify.info が出ている契約。追加通知は出さない。
          return;
        }
        const reachableAfterFetch = await tryCatch(
          rpcGitRevReachable({ dir: initialDir, hash: initialBaseOid }),
        );
        if (seq !== enableSeq.value) return;
        if (!reachableAfterFetch.ok) {
          notify.error(
            "Failed to probe PR diff base reachability after fetch",
            reachableAfterFetch.error,
          );
          return;
        }
        if (!reachableAfterFetch.value.reachable) {
          // fetch は成功したが base ref はまだ届かない = remote 側で削除されている可能性が高い。
          // この経路の文言を merge-base 失敗の「unrelated histories?」と分離する。
          notify.error(
            `PR diff: base commit ${initialBaseOid} not reachable after fetch (base ref may have been removed)`,
          );
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
        // GitOps.mergeBase が空文字を返すのは unrelated histories / validateRev 失敗。reachable は
        // 上で担保済みのため remote 削除経路は除外されており、ここは真に共通祖先が無いケース。
        notify.error("PR diff: cannot resolve merge-base with PR base (unrelated histories?)");
        return;
      }

      // 4. final race check: await 中に live `baseRefOid` / dir が変わっていないか
      if (initialBaseOid !== baseOid.value) return;
      if (initialDir !== worktreeStore.dir) return;

      lockedBase.value = { sourceBaseOid: initialBaseOid, diffBaseOid: mergeBaseOid };
    } finally {
      // seq 一致 = この enable() が現役。disable() / 他経路の `enableSeq++` が割り込んだ場合は
      // 他の write 主体が後続 enable() を始めるのでこの finally は触らない。
      if (seq === enableSeq.value) enabling.value = false;
    }
  }

  function disable() {
    // 進行中の enable() を破棄するため increment。`enabling` は触らず、finally に処理を委ねる。
    enableSeq.value++;
    lockedBase.value = undefined;
  }

  async function toggle() {
    if (isOn.value || enabling.value) {
      disable();
    } else {
      await enable();
    }
  }

  // worktree dir 変化は一次の auto-off トリガ。enable() async 中も dir 変化 → enableSeq increment
  // 経由で結果が破棄され、別 worktree の merge-base が現 worktree の lockedBase に書き込まれる
  // race を構造的に塞ぐ。
  watch(
    () => worktreeStore.dir,
    () => {
      if (!isOn.value && !enabling.value) return;
      const wasOn = isOn.value;
      disable();
      if (wasOn) notify.info("PR diff turned off: worktree changed");
    },
  );

  // ユーザーが graph で commit を select したら toggle を OFF する。
  // `selectionVersion` は select() / selectCompare() のみで increment される SSOT。
  // enabling=true でも isOn=false のままなら toggle の視覚的フィードバックは出ていないので通知しない
  // (silent disable で in-flight enable を破棄するだけ)。
  watch(
    () => gitGraphStore.selectionVersion,
    () => {
      if (!isOn.value) {
        if (enabling.value) disable();
        return;
      }
      disable();
      notify.info("PR diff turned off: git-graph selection changed");
    },
  );

  // live `baseRefOid` を snapshot (`sourceBaseOid`) と比較し、消失 / 変化のいずれかで auto-off。
  // enable() 中は post-await チェックで race を処理するため、ここは ON 中のみ対象 (snapshot 有り)。
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
