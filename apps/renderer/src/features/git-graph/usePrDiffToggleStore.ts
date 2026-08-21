import type { GitPullRequestBadge } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useGitStatusStore, useRemoteFetchStore, useWorktreeStore } from "../worktree";
import { rpcGitMergeBase, rpcGitRevReachable } from "./rpc";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrBadgeStore } from "./usePrBadgeStore";

/** base 端の候補を trunk に近い順で並べる。UI の並び順もこれに従う。 */
const PR_DIFF_MODES = ["stack", "pr"] as const;

export type PrDiffMode = (typeof PR_DIFF_MODES)[number];

const MODE_LABEL: Record<PrDiffMode, string> = {
  stack: "Stack diff",
  pr: "PR diff",
};

const MODE_LOST_CAUSE: Record<PrDiffMode, string> = {
  stack: "the pull request is no longer part of a stack",
  pr: "no pull request is available for the current branch",
};

/**
 * mode ごとの base 端 OID。解決できないときは undefined。
 *
 * mode の違いをこの 1 関数に閉じ、解決チェーン・追従・活性判定は mode を意識しない。空文字を
 * undefined に倒すのは、解決チェーンへ入れると fetch を空撃ちしたうえで merge-base 失敗が
 * `unrelated histories` として通知され、原因が誤分類されるため。
 */
export function prDiffBaseOid(
  pr: GitPullRequestBadge | undefined,
  mode: PrDiffMode,
): string | undefined {
  if (pr === undefined) return undefined;
  const oid = mode === "stack" ? pr.stack?.baseRefOid : pr.baseRefOid;
  if (oid === undefined || oid === "") return undefined;
  return oid;
}

export interface PrDiffOrigin {
  dir: string | undefined;
  baseOid: string | undefined;
  headHash: string | undefined;
}

/**
 * 起点の入力が動いたか。`enable()` は動いていたら解決結果を捨て、追従は解決し直す。
 *
 * HEAD を含めるのが要点。base だけを見ると、同じ既定ブランチから切った PR 間の branch 切替
 * (base OID が同値) を取りこぼす。HEAD の不明は status 未取得であって動いた証拠ではないため
 * stale としない。dir / base の消失は前提そのものが失われるため stale とする。
 */
export function isPrDiffOriginStale(initial: PrDiffOrigin, current: PrDiffOrigin): boolean {
  if (current.dir !== initial.dir) return true;
  if (current.baseOid !== initial.baseOid) return true;
  if (current.headHash !== undefined && current.headHash !== initial.headHash) return true;
  return false;
}

export type PrDiffFollowUp = "keep" | "off" | "unresolved";

/**
 * 解決し直した起点から次の行動を決める。**入力が動いても起点が同じなら維持する** — fast-forward な
 * commit や自分が取り込まない base の前進は入力を動かすが共通祖先を動かさない。
 */
export function decidePrDiffFollowUp(params: {
  resolved: string | undefined;
  pinned: string;
}): PrDiffFollowUp {
  if (params.resolved === undefined) return "unresolved";
  if (params.resolved === params.pinned) return "keep";
  return "off";
}

/**
 * PR diff モード (ChangesPane / PreviewPane を「base..working tree」表示に切り替える) の SSOT。
 * graph 側の選択 state は読むだけで書かない。
 *
 * ## 起点は merge-base
 *
 * base 端の OID を直接起点にすると、分岐後に base が前進した分が逆向きの差分として混入する。
 * 3-dot 構文は working tree を右辺に置けないため、意味論だけ取り出して merge-base を
 * `git diff <merge-base>` の起点に据える。
 *
 * ## OFF は起点が動いたときだけ
 *
 * `sourceBaseOid` / `sourceHeadHash` は再解決の起動条件であって OFF の判定ではない。入力が動いたら
 * `reresolveOrigin` が解決し直し、`diffBaseOid` が変わったときだけ OFF にする。入力の変化で OFF に
 * すると、起点を動かさない操作 (fast-forward な commit 等) で落ちる。維持する再解決は通知しない。
 *
 * dir 変化と graph の選択は起点の前提が変わるため、再解決を経ず即 OFF。
 *
 * ## race token は `enableSeq` 単一
 *
 * 解決チェーンは数秒かかる。
 */
export const usePrDiffToggleStore = defineStore("prDiffToggle", () => {
  const gitGraphStore = useGitGraphStore();
  const prBadgeStore = usePrBadgeStore();
  const worktreeStore = useWorktreeStore();
  const gitStatusStore = useGitStatusStore();
  const fetchStore = useRemoteFetchStore();
  const notify = useNotificationStore();

  /** ON 時に固定した mode と起点。 */
  const lockedBase = ref<
    | { mode: PrDiffMode; sourceBaseOid: string; sourceHeadHash: string; diffBaseOid: string }
    | undefined
  >(undefined);

  const isOn = computed(() => lockedBase.value !== undefined);

  const mode = computed<PrDiffMode | undefined>(() => lockedBase.value?.mode);

  const pr = computed<GitPullRequestBadge | undefined>(() => {
    const branch = gitGraphStore.currentBranch;
    if (branch === undefined) return undefined;
    return prBadgeStore.prByBranch.get(branch);
  });

  function baseOidOf(target: PrDiffMode): string | undefined {
    return prDiffBaseOid(pr.value, target);
  }

  function currentOrigin(target: PrDiffMode): PrDiffOrigin {
    return {
      dir: worktreeStore.dir,
      baseOid: baseOidOf(target),
      headHash: gitStatusStore.headHash,
    };
  }

  const liveBaseOid = computed<string | undefined>(() => {
    const locked = lockedBase.value;
    if (locked === undefined) return undefined;
    return baseOidOf(locked.mode);
  });

  /** 押せる mode。mode ごとの getter に分けると、mode の増減で store と UI の両方に分岐が増える。 */
  const enabledModes = computed<PrDiffMode[]>(() =>
    PR_DIFF_MODES.filter((mode) => baseOidOf(mode) !== undefined),
  );

  /** consumer が読む起点 OID (= merge-base)。mode によらず同じ意味。 */
  const lockedBaseOid = computed<string | undefined>(() => lockedBase.value?.diffBaseOid);

  const enableSeq = ref(0);
  /** 解決中フラグ。**解除は現役でなくなった側が放棄し、割り込んだ側が落とす** — 解除の唯一の口が
   * `enable()` の中にあると、割り込みで seq が進んだ時点で解除者が居なくなり、入口 gate が以降の
   * enable を全部弾く。 */
  const enabling = ref(false);

  /**
   * 起点を解決する。`enable()` と再解決が共有する — 片方だけに手順を置くと、再解決が別の手順へ
   * 退化して ON の起点と再解決後の起点が別の意味を持つ。
   *
   * fetch の入口は呼び出し元が渡す。どちらも backoff は bypass し、失敗通知の方針だけ分かれる。
   */
  async function resolveDiffBase(
    target: PrDiffMode,
    dir: string,
    baseOid: string,
    seq: number,
    requestFetch: (dir: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const label = MODE_LABEL[target];

    const reachable = await tryCatch(rpcGitRevReachable({ dir, hash: baseOid }));
    if (seq !== enableSeq.value) return undefined;
    if (!reachable.ok) {
      notify.error(`Failed to probe ${label} base reachability`, reachable.error);
      return undefined;
    }

    // fetch 成功でも remote で base ref が削除されていれば依然 unreachable。再判定で
    // 「fetch しても届かない」を構造的に検出する。
    if (!reachable.value.reachable) {
      const fetched = await requestFetch(dir);
      if (seq !== enableSeq.value) return undefined;
      // 失敗通知は fetch 経路が出す契約。追加通知は出さない。
      if (!fetched) return undefined;
      const reachableAfterFetch = await tryCatch(rpcGitRevReachable({ dir, hash: baseOid }));
      if (seq !== enableSeq.value) return undefined;
      if (!reachableAfterFetch.ok) {
        notify.error(
          `Failed to probe ${label} base reachability after fetch`,
          reachableAfterFetch.error,
        );
        return undefined;
      }
      if (!reachableAfterFetch.value.reachable) {
        notify.error(
          `${label}: base commit ${baseOid} not reachable after fetch (base ref may have been removed)`,
        );
        return undefined;
      }
    }

    const merged = await tryCatch(rpcGitMergeBase({ dir, hash1: "HEAD", hash2: baseOid }));
    if (seq !== enableSeq.value) return undefined;
    if (!merged.ok) {
      notify.error(`Failed to compute ${label} merge-base`, merged.error);
      return undefined;
    }
    // 空文字は unrelated histories。reachable は上で担保済みなので remote 削除は除外されている。
    if (merged.value.mergeBaseOid === "") {
      notify.error(
        `${label}: cannot resolve merge-base with the base commit (unrelated histories?)`,
      );
      return undefined;
    }
    return merged.value.mergeBaseOid;
  }

  async function enable(target: PrDiffMode) {
    if (isOn.value || enabling.value) return;
    const initialBaseOid = baseOidOf(target);
    if (initialBaseOid === undefined) return;
    const initialDir = worktreeStore.dir;
    if (initialDir === undefined) return;

    // HEAD が取れないまま固定すると、以降の追従判定の基準が無くなる。
    const initialHeadHash = gitStatusStore.headHash;
    if (initialHeadHash === undefined) {
      notify.error(`${MODE_LABEL[target]}: cannot resolve HEAD`);
      return;
    }
    const seq = ++enableSeq.value;
    enabling.value = true;
    try {
      const mergeBaseOid = await resolveDiffBase(
        target,
        initialDir,
        initialBaseOid,
        seq,
        fetchStore.requestImmediateFetch,
      );
      if (mergeBaseOid === undefined) return;

      const initialOrigin = {
        dir: initialDir,
        baseOid: initialBaseOid,
        headHash: initialHeadHash,
      };
      if (isPrDiffOriginStale(initialOrigin, currentOrigin(target))) return;

      lockedBase.value = {
        mode: target,
        sourceBaseOid: initialBaseOid,
        sourceHeadHash: initialHeadHash,
        diffBaseOid: mergeBaseOid,
      };
    } finally {
      if (seq === enableSeq.value) enabling.value = false;
    }
  }

  function disable() {
    enableSeq.value++;
    lockedBase.value = undefined;
    // in-flight の解決は seq 不一致で解除を放棄するため、ここで落とさないと解除者が居なくなる。
    enabling.value = false;
  }

  async function toggle(target: PrDiffMode) {
    if (enabling.value || lockedBase.value?.mode === target) {
      disable();
      return;
    }
    if (isOn.value) disable();
    await enable(target);
  }

  watch(
    () => worktreeStore.dir,
    () => {
      // disable() で mode が消えるため先に取る
      const locked = lockedBase.value;
      if (locked === undefined && !enabling.value) return;
      disable();
      if (locked !== undefined) {
        notify.info(`${MODE_LABEL[locked.mode]} turned off: worktree changed`);
      }
    },
  );

  // enabling=true でも OFF のままなら toggle は ON の視覚的フィードバックを出していないため通知しない。
  watch(
    () => gitGraphStore.selectionVersion,
    () => {
      const locked = lockedBase.value;
      if (locked === undefined) {
        if (enabling.value) disable();
        return;
      }
      disable();
      notify.info(`${MODE_LABEL[locked.mode]} turned off: git-graph selection changed`);
    },
  );

  async function reresolveOrigin() {
    const locked = lockedBase.value;
    if (locked === undefined) return;

    const headHash = gitStatusStore.headHash;
    if (headHash === undefined) return;

    const dir = worktreeStore.dir;
    const baseOid = baseOidOf(locked.mode);
    if (dir === undefined || baseOid === undefined) {
      disable();
      notify.info(`${MODE_LABEL[locked.mode]} turned off: ${MODE_LOST_CAUSE[locked.mode]}`);
      return;
    }
    // dir を両側同値で渡して dir 軸を落とす。dir 変化は専用 watcher が OFF にする。
    const moved = isPrDiffOriginStale(
      { dir, baseOid: locked.sourceBaseOid, headHash: locked.sourceHeadHash },
      { dir, baseOid, headHash },
    );
    if (!moved) return;

    const seq = ++enableSeq.value;
    const mergeBaseOid = await resolveDiffBase(
      locked.mode,
      dir,
      baseOid,
      seq,
      fetchStore.requestFollowUpFetch,
    );
    if (seq !== enableSeq.value) return;
    const current = lockedBase.value;
    if (current === undefined) return;
    const followUp = decidePrDiffFollowUp({
      resolved: mergeBaseOid,
      pinned: current.diffBaseOid,
    });
    if (followUp === "keep") {
      // 次回の比較が空振りしないよう snapshot だけ進める
      lockedBase.value = { ...current, sourceBaseOid: baseOid, sourceHeadHash: headHash };
      return;
    }
    disable();
    if (followUp === "unresolved") {
      notify.info(`${MODE_LABEL[current.mode]} turned off: cannot resolve the diff origin anymore`);
      return;
    }
    notify.info(
      `${MODE_LABEL[current.mode]} turned off: diff origin moved from ${current.diffBaseOid} to ${mergeBaseOid}`,
    );
  }

  // 軸ごとに watcher を分けると、両方が同じ burst で動いたときに再解決が二重に走る。
  watch([liveBaseOid, () => gitStatusStore.headHash], () => {
    void reresolveOrigin();
  });

  return {
    isOn,
    mode,
    enabling,
    pr,
    lockedBaseOid,
    enabledModes,
    enable,
    disable,
    toggle,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrDiffToggleStore, import.meta.hot));
}
