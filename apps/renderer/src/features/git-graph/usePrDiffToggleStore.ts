import type { GitPullRequest } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useGitStatusStore, useRemoteFetchStore, useWorktreeStore } from "../worktree";
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
 * 起点の**入力**が動いたかを判定する。使い所は 2 つあり、結論の意味が異なる。
 *
 * - `enable()` の await 中の破棄判定: 動いていたら結果を捨てる。古い入力で解決した起点を固定する
 *   より、ON にせずユーザーの再押下に委ねる方が安全。窓は数秒なので過剰に捨てても実害が小さい
 * - ON 中の追従の入口: 動いていたら起点を**解決し直す**。ここで OFF にはしない。入力が動いても
 *   起点が同じことは多く (fast-forward な commit・自分が取り込まない base の前進)、入力の変化を
 *   OFF の理由にすると常用に耐えない
 *
 * **HEAD を入力に含める**のが要点。起点は `merge-base(HEAD, base)` なので base だけを見ていると、
 * 同じ dir で branch が切り替わって base OID が同値のまま HEAD だけ動いた場合に、古い HEAD から
 * 計算した merge-base を固定してしまう。base が同じ PR は「同じ既定ブランチから切った複数の PR」で
 * 日常的に生じるため、この経路は例外ではない。
 *
 * HEAD の **不明 (undefined) は「動いた」と扱わない**。status を 1 度も取れていない状態であって、
 * HEAD が動いた証拠ではない。dir / base OID の消失は起点の前提そのものが失われているため stale と
 * して扱う。
 */
export function isPrDiffOriginStale(initial: PrDiffOrigin, current: PrDiffOrigin): boolean {
  if (current.dir !== initial.dir) return true;
  if (current.baseOid !== initial.baseOid) return true;
  if (current.headHash !== undefined && current.headHash !== initial.headHash) return true;
  return false;
}

/** 再解決の結果に対する行動。 */
export type PrDiffFollowUp = "keep" | "off" | "unresolved";

/**
 * 起点を解決し直した結果から次の行動を決める。
 *
 * **入力が動いても起点が同じなら維持する**のがこの判定の要点。fast-forward な commit や、自分が
 * 取り込まない base の前進は入力を動かすが共通祖先を動かさないため、`keep` に落ちる。ここを
 * 「入力が動いたら OFF」にすると、gozd で最頻の操作である commit のたびに表示が落ちる。
 */
export function decidePrDiffFollowUp(params: {
  /** 解決し直した merge-base。解決不能なら undefined */
  resolved: string | undefined;
  /** 現在固定されている起点 */
  pinned: string;
}): PrDiffFollowUp {
  if (params.resolved === undefined) return "unresolved";
  if (params.resolved === params.pinned) return "keep";
  return "off";
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
 *   再 reachable 判定 → merge-base 計算を行い、結果を `lockedBase` に固定する (保持する値の内訳は
 *   `lockedBase` 自身の doc が SSOT。ここで数え直すと片方が古くなる)
 * - `isOn` / `mode` / `disable` は `lockedBase` の有無 / 中身 / クリアとして表現する (派生)
 * - 表示用 / per-file 取得用の起点 OID は **`diffBaseOid` (= merge-base)**。consumer は公開 getter
 *   `lockedBaseOid` 経由で読む (実体は `lockedBase.diffBaseOid`)
 * - `sourceBaseOid` / `sourceHeadHash` は**再解決の起動条件**。起点は `merge-base` の 2 引数から
 *   決まるので、片方だけを追うと同じ base OID のまま HEAD が動いた場合を取りこぼす。OFF の判定は
 *   これらの変化ではなく、再解決した `diffBaseOid` が動いたかで行う
 *
 * ## OFF になる契機
 *
 * **即 OFF にするもの** (起点の前提そのものが消える / ユーザーが別の比較を選んだ)
 *
 * - `worktreeStore.dir` の変化: 起点を計算した対象が別物になる。base OID 経由の間接判定だと
 *   「別 worktree の PR の base OID が偶然同値」の場合に取りこぼすため、dir 変化は独立して watch
 *   する。enable() async 中の dir 切替もこの watcher が `enableSeq` を increment して破棄する
 * - `gitGraphStore.selectionVersion` の increment: ユーザーが graph で commit を選んだ瞬間
 *
 * **再解決を経て判定するもの** (起点の入力が動いた)
 *
 * - live base OID / HEAD が snapshot と変化 → `reresolveOrigin` が `merge-base` を解決し直し、
 *   **値が動いたときだけ** OFF。同値なら snapshot だけ進めて表示を維持する
 *
 * stack の下段 PR が merge されたときに OFF になるかは merge の方式で決まる。merge commit なら
 * 下段の変更が自分の履歴の祖先に入るため起点が前進して OFF、squash / rebase merge なら生成された
 * commit は祖先にならないため起点は動かず維持される。
 *
 * OFF にするときは silent drop 禁止規律に従い `useNotificationStore.info` で通知する (toggle の
 * 見た目が突然変わるのでユーザーに認知させる必要がある)。**維持する再解決は通知しない** —
 * ユーザーから見て何も起きていないため。ただし enable() async 中で `isOn=false` のままだった場合、
 * toggle はまだ ON の視覚的フィードバックを出していないため、graph selection 経由の disable は
 * 通知を出さない (`lockedBase` の有無を判定条件にする)。
 *
 * ## enable() を async にした race 対策
 *
 * reachable / fetch / 再 reachable / merge-base の 4 段チェーンは数秒オーダーになりうる。
 * await 中に
 * - toggle がもう一度押された (= disable / 再 enable)
 * - worktree が切り替わった
 * - 起点の入力 (base OID / HEAD) が変わった
 * のいずれかが起きると snapshot 結果は破棄する。`enableSeq` 単一カウンタを比較して破棄判定する。
 * ON 中の再解決も同じカウンタを進めるため、解決の並走は enable / 再解決をまたいで排他になる。
 */
export const usePrDiffToggleStore = defineStore("prDiffToggle", () => {
  const gitGraphStore = useGitGraphStore();
  const prListStore = usePrListStore();
  const worktreeStore = useWorktreeStore();
  const gitStatusStore = useGitStatusStore();
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
      headHash: gitStatusStore.headHash,
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

  /** 解決の race を破棄するための単調 increment counter。disable() / 連続 enable() / auto-off 経由の
   * disable() / dir 変化 / 起点の入力の変化 (= `reresolveOrigin`) のいずれでも increment され、
   * 進行中の解決は post-await の `seq !== enableSeq.value` チェックで結果を捨てる。 */
  const enableSeq = ref(0);
  /** enable() async の進行中フラグ。toggle button の disabled gate に使う。
   *
   * **解除は「現役でなくなった側が放棄し、割り込んだ側が落とす」**。in-flight の enable() は
   * `enableSeq` が進むと finally での解除を放棄するため、割り込む `disable()` が代わりに落とさないと
   * true のまま残り、入口 gate (`isOn || enabling`) が以降の enable をすべて弾く (= トグルが
   * リロードまで押せなくなる)。解除の唯一の口が enable() の中にある状態を作らない。 */
  const enabling = ref(false);

  /**
   * 起点 (`merge-base(HEAD, base)`) を解決する。reachable 判定 → 必要なら fetch → 再判定 →
   * merge-base の 4 段。解決できなければ undefined を返し、原因は通知済み。
   *
   * `enable()` と再解決の両方が使う。片方だけに解決手順を置くと、再解決が「reachable なら OK」等の
   * 別の手順に退化して、ON の起点と再解決後の起点が別の意味を持つ。
   *
   * `seq` は呼び出し元が握る race トークン。await ごとに現役かを確かめ、割り込まれたら黙って抜ける。
   *
   * **fetch の入口は呼び出し元が渡す**。どちらも backoff は bypass する — base 端が local に無い
   * ことは解決の失敗であって、待てば直るものではない。分けるのは失敗通知の方針だけで、クリック起点は
   * 即通知、自動追従は間引く。解決手順そのものは共有する。
   */
  async function resolveDiffBase(
    target: PrDiffMode,
    dir: string,
    baseOid: string,
    seq: number,
    requestFetch: (dir: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const label = MODE_LABEL[target];

    // 1. reachable 判定: base 端が local repo に届いているか
    const reachable = await tryCatch(rpcGitRevReachable({ dir, hash: baseOid }));
    if (seq !== enableSeq.value) return undefined;
    if (!reachable.ok) {
      notify.error(`Failed to probe ${label} base reachability`, reachable.error);
      return undefined;
    }

    // 2. 未 reachable なら fetch を要求 → 再 reachable 判定。fetch 成功でもリモートで base ref が
    // 削除されていれば依然 unreachable のため、再判定で「fetch しても届かない」を構造的に検出する。
    if (!reachable.value.reachable) {
      const fetched = await requestFetch(dir);
      if (seq !== enableSeq.value) return undefined;
      if (!fetched) {
        // クリック起点では下層が notify.info を出す契約。背景経路は間引きに従うため無音のことも
        // ある。いずれも追加通知は出さない。
        return undefined;
      }
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
        // fetch は成功したが base ref はまだ届かない = remote 側で削除されている可能性が高い。
        // この経路の文言を merge-base 失敗の「unrelated histories?」と分離する。
        notify.error(
          `${label}: base commit ${baseOid} not reachable after fetch (base ref may have been removed)`,
        );
        return undefined;
      }
    }

    // 3. merge-base 計算 (= 3-dot semantics の左端解決)
    const merged = await tryCatch(rpcGitMergeBase({ dir, hash1: "HEAD", hash2: baseOid }));
    if (seq !== enableSeq.value) return undefined;
    if (!merged.ok) {
      notify.error(`Failed to compute ${label} merge-base`, merged.error);
      return undefined;
    }
    if (merged.value.mergeBaseOid === "") {
      // GitOps.mergeBase が空文字を返すのは unrelated histories / validateRev 失敗。reachable は
      // 上で担保済みのため remote 削除経路は除外されており、ここは真に共通祖先が無いケース。
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

    // 起点は merge-base(HEAD, base) なので HEAD も snapshot する。解決できないまま固定すると
    // 以降の追従判定の基準が無くなるため、silent に進めずここで打ち切る。
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

      // final race check: await 中に起点の入力 (dir / base / HEAD) が動いていないか
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

  /**
   * ON 中に起点の入力が動いたときの追従。**入力の変化ではなく起点の変化で OFF する。**
   *
   * fast-forward な HEAD の移動（通常の commit）では `merge-base(HEAD, base)` は動かない。commit が
   * 増やすのは base 側と無関係な子孫だけで、共通祖先は同じ commit のままである。base 端の前進も
   * 同じで、自分のブランチが取り込まない限り共通祖先は動かない。入力の同値性で判定すると、これらを
   * すべて OFF に倒す — gozd では commit が最頻の操作なので、見ている最中に落ち続けることになる。
   *
   * そこで入力が動いたら起点を**解決し直し**、`diffBaseOid` が実際に変わったときだけ OFF にする。
   * 同値なら snapshot だけ差し替えて表示を維持する（ユーザーには何も起きない）。
   *
   * 解決不能になった場合は OFF に倒す。base 端が消えた（PR / stack から外れた）ケースは原因が
   * mode ごとに違うので、そちらは入力の消失として先に判定する。
   */
  async function reresolveOrigin() {
    const locked = lockedBase.value;
    if (locked === undefined) return;

    const headHash = gitStatusStore.headHash;
    // 未取得は「動いた」と扱わない。status を 1 度も取れていない状態は HEAD が動いた証拠ではない。
    if (headHash === undefined) return;

    const dir = worktreeStore.dir;
    const baseOid = baseOidOf(locked.mode);
    if (dir === undefined || baseOid === undefined) {
      disable();
      notify.info(`${MODE_LABEL[locked.mode]} turned off: ${MODE_LOST_CAUSE[locked.mode]}`);
      return;
    }
    // 入力が動いたかの判定は final race check と同じ述語を通す。dir を両側に同じ値で渡して
    // dir 軸を落とす: dir の変化は専用の watcher が OFF にするため、ここでは扱わない。
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
    // 再解決の途中で OFF になっていれば結果を捨てる
    const current = lockedBase.value;
    if (current === undefined) return;
    const followUp = decidePrDiffFollowUp({
      resolved: mergeBaseOid,
      pinned: current.diffBaseOid,
    });
    if (followUp === "keep") {
      // 起点は動いていない。次回の比較が空振りしないよう snapshot だけ進める
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

  // 起点の入力 (base 端 / HEAD) の変化を 1 本の watcher で受け、再解決に委ねる。軸ごとに watcher を
  // 分けると、両方が同じ burst で動いたときに再解決が二重に走る。
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
