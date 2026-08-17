import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRemoteFetchStore, useWorktreeStore } from "../worktree";
import { rpcGitMergeBase, rpcGitRevReachable } from "./rpc";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrListStore } from "./usePrListStore";

/** diff の base 端の候補を trunk に近い順で並べた SSOT。UI の並び順もこれに従う。
 *
 * - `stack`: この PR が属する stack 全体の base (= trunk 側)。stack の下段を含む累積差分になる
 * - `pr`: この PR の base (= stack の中では 1 つ下の PR の head)。GitHub の Files changed と同じ範囲 */
const PR_DIFF_MODES = ["stack", "pr"] as const;

export type PrDiffMode = (typeof PR_DIFF_MODES)[number];

/** mode ごとの表示名。通知は「どちらの diff が落ちたか」を運ぶ必要があるため、文言を mode 非依存に
 * 固定しない。 */
const MODE_LABEL: Record<PrDiffMode, string> = {
  stack: "Stack diff",
  pr: "PR diff",
};

/** base 端が live から消えた原因。mode によって失われるものが違うため、同じ文言で畳まない。 */
const MODE_LOST_CAUSE: Record<PrDiffMode, string> = {
  stack: "the pull request is no longer part of a stack",
  pr: "no pull request is available for the current branch",
};

/**
 * mode ごとの base 端 OID を PR から引く。解決できないときは undefined。
 *
 * mode の違いをこの 1 関数に閉じることで、解決チェーン (reachable → fetch → merge-base)・auto-off・
 * toggle の活性判定がいずれも mode を意識せずに済む。
 *
 * 空文字を undefined に倒すのは、`GitPullRequest` の OID フィールドが「取れなかった」を空文字で
 * 表す契約のため。空文字は rev として git に渡っても fatal になるだけだが、解決チェーンへ入れると
 * reachable 判定の失敗から fetch を空撃ちし、その後の merge-base 失敗が `unrelated histories` として
 * 通知されて原因が誤分類される。
 */
export function prDiffBaseOid(
  pr: GitPullRequest | undefined,
  mode: PrDiffMode,
): string | undefined {
  if (pr === undefined) return undefined;
  const oid = mode === "stack" ? pr.stack?.baseRefOid : pr.baseRefOid;
  if (oid === undefined || oid === "") return undefined;
  return oid;
}

/** 起点 (`merge-base(HEAD, base)`) を決める入力の集合。dir が repo を、base OID と HEAD が
 * merge-base の 2 引数を表す。 */
export interface PrDiffOrigin {
  dir: string | undefined;
  baseOid: string | undefined;
  headHash: string | undefined;
}

/**
 * 固定した起点が現在の入力に対して古くなったかを判定する。`enable()` の await 中の破棄判定が使う。
 * ON 中の追従は原因ごとに通知を分けるため watcher を個別に持つが、判定軸 (dir / base / HEAD) は同じ。
 *
 * **HEAD を入力に含める**のが要点。起点は `merge-base(HEAD, base)` なので base だけを見ていると、
 * 同じ dir で branch が切り替わって base OID が同値のまま HEAD だけ動いた場合に、古い HEAD から
 * 計算した merge-base を固定してしまう。base が同じ PR は「同じ既定ブランチから切った複数の PR」で
 * 日常的に生じるため、この経路は例外ではない。
 *
 * HEAD の **不明 (undefined) は「動いた」と扱わない**。commit グラフのロード中に一時的に解決できない
 * ことがあり、それは UI 側の都合であって HEAD が動いた証拠ではない。dir / base OID の消失は起点の
 * 前提そのものが失われているため stale として扱う。
 */
export function isPrDiffOriginStale(initial: PrDiffOrigin, current: PrDiffOrigin): boolean {
  if (current.dir !== initial.dir) return true;
  if (current.baseOid !== initial.baseOid) return true;
  if (current.headHash !== undefined && current.headHash !== initial.headHash) return true;
  return false;
}

/**
 * PR diff モード (ChangesPane / PreviewPane を「base..working tree」表示に切り替える) の SSOT。
 *
 * 既存の gitGraphStore 選択経路を一切上書きしない (= graph 側の見た目・state は不変)。
 * ChangesPane / PreviewPane / useChangesStore はこのストアの `isOn` / `lockedBaseOid` を見て
 * 表示ソースを分岐する。toggle ON 中も graph 側 selection はユーザーが触ったままの値で残る。
 *
 * ## mode は base 端の出自だけを変える
 *
 * `pr` / `stack` の違いは **どの OID を base 端に選ぶか** に閉じる。reachable 判定 → fetch →
 * merge-base 計算の解決チェーンも、下流 (`lockedBaseOid` の consumer) から見える形も両者で同一。
 * stack diff は「stack 全体の base から working tree まで」で、GitHub の stack UI が「この PR と
 * その下の全 PR」を merge 単位として扱うのと同じ範囲になる。
 *
 * ## 起点は merge-base (= GitHub Files changed と同じ 3-dot semantics)
 *
 * `lockedBaseOid` は base ref の OID ではなく **`merge-base(HEAD, base)`** を保持する。
 * base の OID を直接起点にすると、PR 分岐後に base ブランチが前進した分が逆向きに差分として
 * 混入する (= 「自分のブランチに含まれていない main の変更」が PR diff に紛れ込む)。
 *
 * 3-dot **構文** (`<base>...<head>`) は両辺 commit を要求し working tree を含められないが、
 * **意味論** だけ取り出して merge-base OID を `git diff <merge-base>` (右辺省略 = working tree) の
 * 起点に据えれば、working tree 含有と 3-dot semantics を両立できる。
 *
 * ## state の SSOT は `lockedBase`
 *
 * - `enable(mode)` 時に「現在の mode の base OID」を起点に reachable 判定 → fetch (必要なら) →
 *   再 reachable 判定 → merge-base 計算を行い、`{ mode, sourceBaseOid: base OID snapshot,
 *   diffBaseOid: merge-base OID }` を保持する
 * - `isOn` / `mode` / `disable` は `lockedBase` の有無 / 中身 / クリアとして表現する (派生)
 * - 表示用 / per-file 取得用の起点 OID は **`diffBaseOid` (= merge-base)**。consumer は公開 getter
 *   `lockedBaseOid` 経由で読む (実体は `lockedBase.diffBaseOid`)
 * - auto-off の比較対象は **`sourceBaseOid` と `sourceHeadHash`**。起点は `merge-base` の 2 引数から
 *   決まるので、片方だけを追うと同じ base OID のまま HEAD が動いた場合を取りこぼす
 *
 * ## auto-off の一次トリガ
 *
 * - `worktreeStore.dir` の変化: enable() の起点入力が変わるため一次トリガ。base OID 経由の
 *   間接判定だと「別 worktree の PR の base OID が偶然同値」の場合に取りこぼすため、dir 変化は
 *   独立して watch する。enable() async 中の dir 切替もこの watcher が `enableSeq` を increment
 *   して破棄する (race 防護)
 * - `gitGraphStore.selectionVersion` の increment: ユーザーが graph で commit を選んだ瞬間
 * - live base OID が `sourceBaseOid` snapshot と変化: base end が動いた / 消失
 * - `gitGraphStore.headHash` が `sourceHeadHash` snapshot と変化: `merge-base` のもう一方の引数が
 *   動いた (rebase / commit / 同一 dir での branch 切替)
 *
 * stack mode の base 端は trunk の tip なので、**stack の下段 PR が merge されると必ず OFF になる**。
 * merge は trunk を前進させ、さらに GitHub は次の未 merge PR を trunk 直下へ rebase する
 * (= base 端を持つ position 1 の PR 自体が入れ替わる)。どちらの経路でも base 端の OID が動く。
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

  /** ON 時に snapshot された mode と起点の入力。undefined のとき OFF (== `isOn=false`)。
   *
   * - `mode`: どちらの base 端を起点にしたか。auto-off 判定で live 値を引く先を決める
   * - `sourceBaseOid`: enable 時の live base OID。auto-off 判定で live 値と比較する
   * - `sourceHeadHash`: enable 時の HEAD。`merge-base` のもう一方の引数なので、これも追従対象
   * - `diffBaseOid`: `merge-base(HEAD, sourceBaseOid)`。diff / per-file 取得の起点 */
  const lockedBase = ref<
    | { mode: PrDiffMode; sourceBaseOid: string; sourceHeadHash: string; diffBaseOid: string }
    | undefined
  >(undefined);

  /** PR diff モードが ON か。`lockedBase` の有無で一意に決まる派生値。 */
  const isOn = computed(() => lockedBase.value !== undefined);

  /** ON 中の mode。OFF 時は undefined。UI がどちらの toggle を点灯させるかの判定軸。 */
  const mode = computed<PrDiffMode | undefined>(() => lockedBase.value?.mode);

  /** 現在 branch (HEAD が指すブランチ) の PR。無ければ undefined。 */
  const pr = computed<GitPullRequest | undefined>(() => {
    const branch = gitGraphStore.currentBranch;
    if (branch === undefined) return undefined;
    return prListStore.prByBranch.get(branch);
  });

  /** mode ごとの **live** base commit OID。enable() の起点 / auto-off の比較対象に使う。 */
  function baseOidOf(target: PrDiffMode): string | undefined {
    return prDiffBaseOid(pr.value, target);
  }

  /** 現在の起点入力。`enable()` の破棄判定が snapshot と突き合わせる相手。 */
  function currentOrigin(target: PrDiffMode): PrDiffOrigin {
    return {
      dir: worktreeStore.dir,
      baseOid: baseOidOf(target),
      headHash: gitGraphStore.headHash,
    };
  }

  /** ON 中の mode に対応する live base OID。OFF 時は undefined。auto-off watcher の監視源。 */
  const liveBaseOid = computed<string | undefined>(() => {
    const locked = lockedBase.value;
    if (locked === undefined) return undefined;
    return baseOidOf(locked.mode);
  });

  /** 押せる mode を `PR_DIFF_MODES` の順で返す。base 端の OID が解決できているかだけで決まり、
   * merge-base 計算は `enable()` 実行時に行う。
   *
   * mode ごとの getter に分けない: mode の増減で store と UI の両方に分岐が増え、`prDiffBaseOid` に
   * 閉じたはずの mode の違いが活性判定として再び散らばる。 */
  const enabledModes = computed<PrDiffMode[]>(() =>
    PR_DIFF_MODES.filter((mode) => baseOidOf(mode) !== undefined),
  );

  /** consumer (useChangesStore / PreviewPane / ChangesSummaryItem) が読む起点 OID。
   * **merge-base OID** (= `lockedBase.diffBaseOid`)。OFF 時 undefined。mode によらず同じ意味。 */
  const lockedBaseOid = computed<string | undefined>(() => lockedBase.value?.diffBaseOid);

  /** enable() async race を破棄するための単調 increment counter。disable() / 連続 enable() /
   * auto-off 経由 disable() / dir 変化 / base OID 変化 のいずれでも increment され、
   * 進行中の enable() は post-await の `seq !== enableSeq.value` チェックで結果を捨てる。 */
  const enableSeq = ref(0);
  /** enable() async の進行中フラグ。toggle button の disabled gate に使う。
   *
   * **解除は「現役でなくなった側が放棄し、割り込んだ側が落とす」**。in-flight の enable() は
   * `enableSeq` が進むと finally での解除を放棄するため、割り込む `disable()` が代わりに落とさないと
   * true のまま残り、入口 gate (`isOn || enabling`) が以降の enable をすべて弾く (= トグルが
   * リロードまで押せなくなる)。解除の唯一の口が enable() の中にある状態を作らない。 */
  const enabling = ref(false);

  async function enable(target: PrDiffMode) {
    if (isOn.value || enabling.value) return;
    const initialBaseOid = baseOidOf(target);
    if (initialBaseOid === undefined) return;
    const initialDir = worktreeStore.dir;
    if (initialDir === undefined) return;

    const label = MODE_LABEL[target];
    // 起点は merge-base(HEAD, base) なので HEAD も snapshot する。解決できないまま固定すると
    // 以降の追従判定の基準が無くなるため、silent に進めずここで打ち切る。
    const initialHeadHash = gitGraphStore.headHash;
    if (initialHeadHash === undefined) {
      notify.error(`${label}: cannot resolve HEAD (commit graph is not loaded yet)`);
      return;
    }
    const seq = ++enableSeq.value;
    enabling.value = true;
    try {
      // 1. reachable 判定: baseRefOid が local repo に届いているか
      const reachable = await tryCatch(
        rpcGitRevReachable({ dir: initialDir, hash: initialBaseOid }),
      );
      if (seq !== enableSeq.value) return;
      if (!reachable.ok) {
        notify.error(`Failed to probe ${label} base reachability`, reachable.error);
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
            `Failed to probe ${label} base reachability after fetch`,
            reachableAfterFetch.error,
          );
          return;
        }
        if (!reachableAfterFetch.value.reachable) {
          // fetch は成功したが base ref はまだ届かない = remote 側で削除されている可能性が高い。
          // この経路の文言を merge-base 失敗の「unrelated histories?」と分離する。
          notify.error(
            `${label}: base commit ${initialBaseOid} not reachable after fetch (base ref may have been removed)`,
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
        notify.error(`Failed to compute ${label} merge-base`, merged.error);
        return;
      }
      const mergeBaseOid = merged.value.mergeBaseOid;
      if (mergeBaseOid === "") {
        // GitOps.mergeBase が空文字を返すのは unrelated histories / validateRev 失敗。reachable は
        // 上で担保済みのため remote 削除経路は除外されており、ここは真に共通祖先が無いケース。
        notify.error(
          `${label}: cannot resolve merge-base with the base commit (unrelated histories?)`,
        );
        return;
      }

      // 4. final race check: await 中に起点の入力 (dir / base / HEAD) が動いていないか
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
      // seq 一致 = この enable() が現役。割り込まれた場合は解除の所有が割り込み側 (disable() か
      // 後続の enable()) へ移っているため触らない。
      if (seq === enableSeq.value) enabling.value = false;
    }
  }

  function disable() {
    // 進行中の enable() を破棄するため increment。
    enableSeq.value++;
    lockedBase.value = undefined;
    // in-flight の enable() は seq 不一致で finally の解除を放棄する。ここで落とさないと解除者が
    // 誰も居なくなり、以降の enable が入口 gate で弾かれ続ける。
    enabling.value = false;
  }

  /** 指定 mode の toggle を押したときの遷移。
   *
   * 同一 mode の再押下は OFF。別 mode の押下は現在の mode を OFF にしてから enable するため、
   * 2 つの mode が同時に ON になることはない (base 端は常に 1 つ)。 */
  async function toggle(target: PrDiffMode) {
    if (enabling.value || lockedBase.value?.mode === target) {
      disable();
      return;
    }
    if (isOn.value) disable();
    await enable(target);
  }

  // worktree dir 変化は一次の auto-off トリガ。enable() async 中も dir 変化 → enableSeq increment
  // 経由で結果が破棄され、別 worktree の merge-base が現 worktree の lockedBase に書き込まれる
  // race を構造的に塞ぐ。
  watch(
    () => worktreeStore.dir,
    () => {
      // disable() で mode が消えるため、通知に載せる mode は先に narrowing しておく
      const locked = lockedBase.value;
      if (locked === undefined && !enabling.value) return;
      disable();
      if (locked !== undefined) {
        notify.info(`${MODE_LABEL[locked.mode]} turned off: worktree changed`);
      }
    },
  );

  // ユーザーが graph で commit を select したら toggle を OFF する。
  // `selectionVersion` は select() / selectCompare() のみで increment される SSOT。
  // enabling=true でも isOn=false のままなら toggle の視覚的フィードバックは出ていないので通知しない
  // (silent disable で in-flight enable を破棄するだけ)。
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

  // ON 中の mode に対応する live base OID を snapshot (`sourceBaseOid`) と比較し、消失 / 変化の
  // いずれかで auto-off。`liveBaseOid` は OFF 時 undefined なので、snapshot 不在の早期 return が
  // そのまま「OFF 中は監視しない」になる。
  // enable() 中は post-await チェックで race を処理するため、ここは ON 中のみ対象 (snapshot 有り)。
  watch(liveBaseOid, (current) => {
    const locked = lockedBase.value;
    if (locked === undefined) return;
    const label = MODE_LABEL[locked.mode];
    if (current === undefined) {
      disable();
      // 消えたのが PR 自体か stack の帰属かで原因が違う。mode 別に出さないと、stack が外れただけの
      // ときに「PR が無くなった」と告げることになる。
      notify.info(`${label} turned off: ${MODE_LOST_CAUSE[locked.mode]}`);
      return;
    }
    if (current !== locked.sourceBaseOid) {
      disable();
      notify.info(
        `${label} turned off: base commit changed from ${locked.sourceBaseOid} to ${current}`,
      );
    }
  });

  // HEAD は `merge-base` のもう一方の引数なので、動けば固定した起点が古くなる。rebase / commit /
  // 同一 dir での branch 切替が対象。stack mode は起点が trunk 側にあり HEAD からの距離が長いため、
  // 取りこぼすと「取り込んだ trunk の変更が自分の変更として出る」形で差分が壊れる。
  watch(
    () => gitGraphStore.headHash,
    (current) => {
      const locked = lockedBase.value;
      if (locked === undefined) return;
      // ロード中の不明は HEAD が動いた証拠ではない (`isPrDiffOriginStale` と同じ扱い)
      if (current === undefined) return;
      if (current === locked.sourceHeadHash) return;
      disable();
      notify.info(
        `${MODE_LABEL[locked.mode]} turned off: HEAD moved from ${locked.sourceHeadHash} to ${current}`,
      );
    },
  );

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
