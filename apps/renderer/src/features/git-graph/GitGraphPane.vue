<doc lang="md">
Git commit graph showing the current worktree branch and the default branch.

## Structure

- Working Tree row: sticky header outside scroll area, with status icons and dot on lane 0
- Connector line: dashed SVG path from lane 0 top to HEAD lane (straight if same lane, Bézier curve otherwise)
- Scrollable commit list: HTML rows for commit data + SVG overlay for graph lines and dots
- HEAD is pinned to the leftmost lane (lane 0) so it aligns under the Working Tree dot. When HEAD is not the topmost commit, lane 0 is reserved as an empty channel above HEAD so the connector descends without crossing other lanes; commits above HEAD (diverged branches, or HEAD's own children in a detached-HEAD view) are pushed to lanes ≥ 1 and HEAD's children merge back into lane 0 at HEAD's row. See `graphLayout.ts` for the lane assignment
- HEAD also gets a reserved fixed color (`HEAD_COLOR`) in `graphLayout.ts`, so lane 0 (the current branch line) is always the same color regardless of draw order; other lanes are numbered from 1 to avoid the clash. The Working Tree dot/connector read the HEAD node's color (`headColor`) so they match HEAD instead of being hardcoded
- CommitDetailPane is shown as a toggleable right pane inside the graph
- Commits are stored in `useGitGraphStore` and shared with ChangesPane

## 右クリックメニュー

commit 行を右クリックすると `CommitContextMenu` (singleton popover) が開き、「Reset (mixed) to here」で
その commit へ `git reset --mixed` を実行する。`dir` / `hash` は右クリック時点で snapshot し、`pointerup`
once-capture で WebKit の light-dismiss を回避する。内部仕様は `useCommitContextMenu.ts` の docstring を
SSOT として参照する。Working Tree 行はメニュー対象外。
</doc>

<script setup lang="ts">
import type { GitCommit, GitPullRequest } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useElementSize, useEventListener, useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { ResizeHandle } from "../layout";
import { ghErrorMessage, rpcGitPrList } from "../palette";
import type { BranchChangePayload, FsWatchReadyPayload, RemoteRefsChangePayload } from "../sidebar";
import type { GitStatusChangePayload } from "../worktree";
import {
  UNCOMMITTED_HASH,
  computeStatusIcons,
  StatusIcons,
  useGitStatusStore,
  useWorktreeStore,
} from "../worktree";
import CommitContextMenu from "./CommitContextMenu.vue";
import CommitDetailPane from "./CommitDetailPane.vue";
import CommitSegmentList from "./CommitSegmentList";
import type { DisplayRef } from "./displayRef";
import { computeGraphLayout } from "./graphLayout";
import type { GraphLayout } from "./graphLayout";
import type { CommitMessageSegment } from "./linkifyCommitMessage";
import { buildRepoBaseUrl, linkifyCommitMessage } from "./linkifyCommitMessage";
import { mergeCommitStreams } from "./mergeCommitStreams";
import type { SortMode } from "./mergeCommitStreams";
import RefBadge from "./RefBadge.vue";
import { rpcGitGithubIdentity, rpcGitLog } from "./rpc";
import { useCommitContextMenu } from "./useCommitContextMenu";
import { useGitGraphStore } from "./useGitGraphStore";

const rootRef = useTemplateRef<HTMLElement>("root");
const { width: rootWidth } = useElementSize(rootRef);
const worktreeStore = useWorktreeStore();
const gitStatusStore = useGitStatusStore();
const gitGraphStore = useGitGraphStore();
const notify = useNotificationStore();
const repoStore = useRepoStore();
const { gitStatuses } = storeToRefs(gitStatusStore);

const { commits } = storeToRefs(gitGraphStore);
const defaultBranch = ref<string | undefined>();
const layout = ref<GraphLayout>({ nodes: [], lines: [], maxLanes: 1 });
const firstParentOnly = ref(false);
const sortMode = ref<SortMode>("date");
const currentBranchOnly = ref(false);

/** 変更ファイル数 */
const uncommittedChangeCount = computed(() => Object.keys(gitStatuses.value).length);

/** 変更をアイコン付きカウントに変換 */
const statusIcons = computed(() => computeStatusIcons(gitStatuses.value));

/** コミットリスト全体から HEAD が指すカレントブランチ名を取得 */
const currentBranch = computed(() => {
  for (const commit of commits.value) {
    const branch = findCurrentBranch(commit.refs);
    if (branch) return branch;
  }
  return undefined;
});

/**
 * ローカルとリモートが異なるコミットに存在するブランチ名の Set。
 * 同じコミットにローカルとリモートが両方あれば synced（computeDisplayRefs で処理）。
 * 別コミットに分かれていれば out-of-sync としてここで検出する。
 *
 * 検出範囲は `commits.value` に出現する ref に限定される。`currentBranchOnly` が ON のとき
 * `defaultBranchCommits` 由来の commit が消えるため、HEAD 系統から到達しない ref ペアの
 * out-of-sync は検出できない。これは toggle の意味（「current branch だけ表示」=「他系統を
 * 隠す」）の直接の帰結であり、副作用ではない。
 */
const outOfSyncBranches = computed(() => {
  const localCommits = new Map<string, string>();
  const remoteCommits = new Map<string, string>();

  for (const commit of commits.value) {
    for (const r of commit.refs) {
      if (r === "HEAD" || r === "origin/HEAD") continue;
      if (r.startsWith("tag:")) continue;
      if (r.startsWith("origin/")) {
        const name = r.slice("origin/".length);
        remoteCommits.set(name, commit.hash);
      } else {
        localCommits.set(r, commit.hash);
      }
    }
  }

  const result = new Set<string>();
  for (const [name, localHash] of localCommits) {
    const remoteHash = remoteCommits.get(name);
    if (remoteHash && remoteHash !== localHash) {
      result.add(name);
    }
  }
  return result;
});

/** refs 配列に "HEAD" を持つコミットを探す */
function findHeadCommit(rawCommits: GitCommit[]): GitCommit | undefined {
  return rawCommits.find((c) => c.refs.includes("HEAD"));
}

function recomputeLayout() {
  layout.value = computeGraphLayout(commits.value, {
    headHash: findHeadCommit(commits.value)?.hash,
  });
}

/**
 * refs に "HEAD" を持つ表示中ノードとその行番号。
 * Working Tree 行の接続線・色、HEAD レーン番号の単一導出元 (SSOT)。
 */
const headNode = computed(() => {
  const index = layout.value.nodes.findIndex((n) => n.commit.refs.includes("HEAD"));
  if (index === -1) return undefined;
  return { node: layout.value.nodes[index], index };
});

/**
 * HEAD ノードの色インデックス。Working Tree のドット/接続線を HEAD レーンと同色に揃える。
 * HEAD は lane 0 上で HEAD コミットの真上に乗る存在なので、HEAD が tip で
 * teal 以外の色になっても Working Tree 側を追従させて色の食い違いを防ぐ。
 * HEAD 不在時は colorFor(0) = teal にフォールバックする。
 */
const headColor = computed(() => headNode.value?.node.color ?? 0);

// 以下 3 つの「前回値」は **active worktree dir に対する不変条件** として保持する。
// 全 worktree watch / 全 worktree push 設計では、別 worktree の
// gitStatusChange が active dir の前回値を踏み潰さないよう、push handler 側で
// 必ず `payload.dir === worktreeStore.dir` を確認してからこれらを更新する。
// worktree 切替時 (loadLog) には新 dir の取得結果でリセットする。

/** active worktree の前回 HEAD ハッシュ。gitStatusChange で変化を検知するために使用 */
let lastHead = "";
/** active worktree の前回 HEAD が指す branch 名。`git branch -m` は OID を変えないため、
 * rename を gitStatusChange 経路で検知するためにこの値の変化を追う。 */
let lastBranchHead = "";
/** active worktree の前回 upstream ahead/behind。push/fetch による ref 変化を検知するために使用 */
let lastUpstream = "";
/** loadLog の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadLogGen = 0;
/** 現在 in-flight な `loadLog` 呼び出しの数。`scheduleLoadLog` の coalescing 判定に使う。
 * boolean 1 個では、明示 trigger (worktree 切替 / firstParentOnly / `headChanged` 経路) の
 * loadLog と burst 由来の trailing fetch が交錯する thin window で「最後の finally が
 * 抜けた瞬間」を取れず、burst N 発火を最大 2 fetch に集約する保証が崩れる。
 * counter にすると `count === 0` で「全 in-flight 完了」を厳密に判定でき、pending の
 * 消費タイミングが「最後の loadLog の finally」に固定される。 */
let loadLogInFlightCount = 0;
/** in-flight 中に `scheduleLoadLog` が来たかを示す 1 bit。`loadLogInFlightCount === 0` に
 * 落ちた時点で 1 度だけ trailing fetch を発射する。burst N 発火を最大 2 fetch (in-flight + trailing)
 * に集約する。 */
let loadLogScheduled = false;

/** @returns 世代チェックを通過して state を更新した場合 true */
async function loadLog(): Promise<boolean> {
  loadLogInFlightCount += 1;
  try {
    return await runLoadLog();
  } finally {
    loadLogInFlightCount -= 1;
    // 最後の in-flight が完了したタイミングでだけ trailing を発射する。並走 loadLog の
    // 途中で抜けた finally では pending を消費せず、最終の 1 つに集約する。
    if (loadLogInFlightCount === 0 && loadLogScheduled) {
      loadLogScheduled = false;
      // ここで await すると caller の世代に乗らずタイミングが歪むため、fire-and-forget。
      void loadLog();
    }
  }
}

/** push burst (`gitStatusChange` + `remoteRefsChange` + `branchChange` 連射) からの fire-and-forget
 * 経路。in-flight な loadLog があれば trailing 1 fetch にまとめ、なければ即 loadLog する。
 * 戻り値を必要としない、scroll を制御しない、await されない呼び出しはこちらを使う。
 *
 * 明示 trigger 用の `loadLog` を直接呼ばないのは、`refs/remotes/*` 1 回の write で
 * `gitStatusChange` + `remoteRefsChange` が両方発射され、さらに `packed-refs` だと
 * `branchChange` も伴って同じ burst 内で `rpcGitLog` が 2〜3 回並列発射されるため。
 * `loadLogGen` の世代管理は到達した結果を捨てる事後防衛で、`rpcGitLog` の発射自体は
 * 抑止しない (native 側の git 実行コスト / observability ログ汚染が残る)。
 * `scheduleLoadLog` は発射そのものを抑止する事前防衛。
 *
 * 明示 trigger 由来の `await loadLog()` (`headChanged` 経路 / worktree 切替 / firstParentOnly)
 * も `loadLogInFlightCount > 0` を立てるため、同 burst 内の `scheduleLoadLog` は trailing 側に
 * 畳まれる。明示 trigger 経路と burst 経路が同じ counter を共有することで coalescing が
 * 両方向に働く。 */
function scheduleLoadLog() {
  if (loadLogInFlightCount > 0) {
    loadLogScheduled = true;
    return;
  }
  void loadLog();
}

async function runLoadLog(): Promise<boolean> {
  const gen = ++loadLogGen;
  const dir = worktreeStore.dir;
  if (dir === undefined) return false;
  const result = await rpcGitLog({
    dir,
    maxCount: 200,
    firstParentOnly: firstParentOnly.value,
    currentBranchOnly: currentBranchOnly.value,
  });
  if (gen !== loadLogGen) return false;

  const merged = mergeCommitStreams({
    headCommits: result.headCommits,
    defaultBranchCommits: result.defaultBranchCommits,
    sortMode: sortMode.value,
  });

  commits.value = merged;
  defaultBranch.value = result.defaultBranch === "" ? undefined : result.defaultBranch;
  const headCommit = findHeadCommit(merged);
  lastHead = headCommit?.hash ?? "";
  // `lastBranchHead` も loadLog の結果に合わせて更新する。これをやらないと worktree
  // 切替後の最初の gitStatusChange push で branchHeadChanged が偽陽性で立ち、
  // 冗長な 2 度目の loadLog が走る（lastHead との非対称を防ぐ）。
  lastBranchHead = headCommit !== undefined ? (findCurrentBranch(headCommit.refs) ?? "") : "";
  recomputeLayout();

  // 選択中・比較中のコミットが一覧から消えた場合はクリア
  const { selectedHash, compareHash } = gitGraphStore;
  const isStale = (hash: string | null): boolean =>
    hash !== null && hash !== UNCOMMITTED_HASH && !merged.some((c) => c.hash === hash);

  if (isStale(selectedHash) || isStale(compareHash)) {
    gitGraphStore.resetSelection();
  }
  return true;
}

onMounted(loadLog);

// worktree 切り替え時に再取得し、HEAD にスクロール
watch(
  () => worktreeStore.dir,
  async () => {
    gitGraphStore.resetSelection();
    // 3 つの closure 変数すべてを reset する。loadLog の await 中に新 worktree の
    // gitStatusChange が到達すると、旧 worktree の lastHead / lastBranchHead と比較して
    // 偽陽性 (headChanged / branchHeadChanged) を立て、追加 loadLog が走る。upstream だけ
    // 空にして他を loadLog 完了後の再記録に頼ると、reset と再記録の非対称が事故源になる。
    lastHead = "";
    lastBranchHead = "";
    lastUpstream = "";
    const updated = await loadLog();
    if (!updated) return;
    await nextTick();
    scrollHeadIntoView();
  },
);

// firstParentOnly / sortMode 切替時に再取得
watch(firstParentOnly, () => {
  gitGraphStore.resetSelection();
  void loadLog();
});
watch(sortMode, () => {
  gitGraphStore.resetSelection();
  void loadLog();
});
watch(currentBranchOnly, () => {
  gitGraphStore.resetSelection();
  void loadLog();
});

// git status 変更時: Working Tree 固定行の件数・アイコンは computed で自動更新されるため watcher 不要

// HEAD 変更（コミット、リベース等）/ branch 名変更（git branch -m）/ upstream 変更（push、fetch）
// を検知して git log を再取得する。`git branch -m` は OID を変えないため、
// head ハッシュだけで判定すると rename が漏れる。branchHead（HEAD が指す branch 名）の
// 変化も発火条件に含めて、SSOT 経路の取りこぼしを構造的に防ぐ。
const disposeGitStatus = onMessage<GitStatusChangePayload>(
  "gitStatusChange",
  ({ dir, head, branchHead, upstream }) => {
    // active worktree dir 以外の push は無視。closure 変数 (lastHead / lastBranchHead /
    // lastUpstream) は active dir の不変条件として保持しているため、別 worktree の値で
    // 上書きすると active dir に戻ったときに偽陽性で再 fetch が走る。
    if (dir !== worktreeStore.dir) return;
    const upstreamKey = upstream !== undefined ? `${upstream.ahead}/${upstream.behind}` : "";
    const headChanged = head !== "" && head !== lastHead;
    const branchHeadChanged = branchHead !== lastBranchHead;
    const upstreamChanged = upstreamKey !== lastUpstream;

    if (headChanged) lastHead = head;
    if (branchHeadChanged) lastBranchHead = branchHead;
    if (upstreamChanged) lastUpstream = upstreamKey;

    // headChanged は HEAD コミット位置にスクロールしたいため await loadLog で結果を待つ。
    // branchHead / upstream 変化のみの場合は scroll 不要なので scheduleLoadLog で coalesce
    // させる (`refs/remotes/*` で gitStatusChange + remoteRefsChange が両方発射される burst
    // でもここを scheduleLoadLog にしておけば 2 重 fetch を畳める)。
    if (headChanged) {
      void (async () => {
        const updated = await loadLog();
        if (!updated) return;
        await nextTick();
        scrollHeadIntoView();
      })();
    } else if (branchHeadChanged || upstreamChanged) {
      scheduleLoadLog();
    }
    // `upstreamChanged` (`# branch.ab` の ahead/behind 数値が変化) の主要発生経路は:
    //   1. HEAD 移動 → `headChanged` の if 経路に流れて else if に来ない
    //   2. `refs/remotes/origin/<current-branch>` の書き換え → 同 burst で必ず `remoteRefsChange` 発射
    // よって本 else if に到達する `upstreamChanged` は (2) に限られ、`loadPrList` は
    // `remoteRefsChange` handler 側に集約してよい (両方で呼ぶと `gh pr list` 2 連射)。
    // 例外: `git branch --set-upstream-to` / `--unset-upstream` で `.git/config` だけが変わる
    // 経路は classify の射程外 (refs を動かさない) ため、その後の何か別 trigger で本 else if
    // に流れることがある。本 PR の射程では 60s polling で吸収する想定。
  },
);
onUnmounted(disposeGitStatus);

// ブランチ ref の変更 (作成・削除・リネーム) は repo 共有の commonGitDir で起き、
// 同 repo の worktree 群のうち primary 1 つだけが push される。primary が active と
// 一致するとは限らないため、`isSameRepoAsActive` で active と同じ repo か判定する。
const disposeBranchChange = onMessage<BranchChangePayload>("branchChange", ({ dir }) => {
  if (!repoStore.isSameRepoAsActive(dir)) return;
  scheduleLoadLog();
});
onUnmounted(disposeBranchChange);

// `git fetch` / `git push` でローカルの remote-tracking ref が動いたとき発火する。
// `gitStatusChange` 経路は current branch の upstream key (ahead/behind) しか
// 変化を載せないため、別ブランチ (`origin/other-branch`) だけが動いた場合に取り
// こぼす。`remoteRefsChange` はこれを補う repo スコープ通知。
// 同じ remote ref burst で `gitStatusChange` 経路と本 handler の両方が `loadLog` を立てるため、
// `scheduleLoadLog` で coalescing して 1〜2 fetch にまとめる。
// PR 一覧の即時反映もここで取り直す: 外部端末で current 以外の branch に push されて gh 側で
// 新規 PR が立った直後にバッジを動かしたい運用要件と整合する。`loadPrList` は本 handler を
// SSOT 発火元として `disposeGitStatus.upstreamChanged` 側では呼ばない (current branch ref の
// 書き換えでも本 handler が同 burst で必ず発射されるため、両方呼ぶと `gh pr list` 2 連射になる)。
const disposeRemoteRefsChange = onMessage<RemoteRefsChangePayload>(
  "remoteRefsChange",
  ({ dir }) => {
    if (!repoStore.isSameRepoAsActive(dir)) return;
    scheduleLoadLog();
    void loadPrList();
  },
);
onUnmounted(disposeRemoteRefsChange);

// `useFsWatchSync` の `rpcFsWatch` 完了直後に発射される再同期通知。watch 起動往復中の
// FS 変化を救済するため、1 度だけ git log を取り直す。dispatch 側で rootDir 単位に
// dedup されており、payload.dir は repo の代表 worktree (active とは限らない) なので、
// `isSameRepoAsActive` で active と同じ repo か判定する。
const disposeFsWatchReady = onMessage<FsWatchReadyPayload>("fsWatchReady", ({ dir }) => {
  if (!repoStore.isSameRepoAsActive(dir)) return;
  scheduleLoadLog();
});
onUnmounted(disposeFsWatchReady);

// --- PR 情報（非同期で後追い取得） ---

/** ブランチ名 → PR のマップ */
const prByBranch = ref(new Map<string, GitPullRequest>());
/** loadPrList の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadPrGen = 0;

/** PR 一覧を取得して prByBranch を更新する。
 * 失敗時は前回値を保持しつつ notify.error でユーザーに告知する。silent 化すると
 * バッジが古い値のまま表示され続け、rate limit / 未認証 等の発生に気づけない。
 * 同一エラーの連続発生は notification store 側で重ね合わせ (回数 badge) として処理する。 */
async function loadPrList() {
  const gen = ++loadPrGen;
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  const result = await tryCatch(rpcGitPrList({ dir }));
  if (gen !== loadPrGen) return;
  if (!result.ok) {
    notify.error("Failed to load pull requests", result.error);
    return;
  }
  const res = result.value;
  if (!res.ok) {
    notify.error(
      ghErrorMessage(res.errorKind, "Failed to load pull requests"),
      res.errorDetail || undefined,
    );
    return;
  }
  const map = new Map<string, GitPullRequest>();
  for (const pr of res.prs) {
    map.set(pr.headRef, pr);
  }
  prByBranch.value = map;
}

// --- GitHub repo identity (コミットメッセージ `#N` リンク化の SSOT) ---

/** active worktree の origin remote を parse した `(owner, repo)`。
 * Swift 側 `GitHubOps.parseGitHubOwnerRepo` 経由のため、`gh pr list` と同じ host policy
 * (github.com 限定) で揃う。remote 未設定 / 非 github.com host は両フィールドが空文字で届く。
 * worktree 切替時に 1 回だけ取得。push / fetch 等の SSOT push 経路では再取得不要
 * (remote URL は `git remote set-url` でしか変わらず、それは FSEvents の射程外で
 * 低頻度な手動操作のため、active 切替時の取得で実用上十分)。 */
const repoIdentity = ref({ owner: "", repo: "" });
/** loadRepoIdentity の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadRepoIdentityGen = 0;

async function loadRepoIdentity() {
  const gen = ++loadRepoIdentityGen;
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  const result = await tryCatch(rpcGitGithubIdentity({ dir }));
  if (gen !== loadRepoIdentityGen) return;
  if (!result.ok) {
    // launch failure は git CLI 解決失敗 (PATH 不在等) のみ。
    // remote 未設定 / 非 github は native 側で空文字 + stderr ログに倒すため、ここには来ない。
    notify.error("Failed to load GitHub identity", result.error);
    return;
  }
  repoIdentity.value = { owner: result.value.owner, repo: result.value.repo };
}

/** GitHub repo base URL (`https://github.com/<owner>/<repo>`)。
 * コミットメッセージの `#N` リンク化に使う。remote 未設定 / 非 github.com host は undefined。 */
const issueLinkBaseUrl = computed(() => buildRepoBaseUrl(repoIdentity.value));

/** 表示中の各 commit の subject を linkify した segments を hash で引ける map。
 * template から関数呼び出しすると毎 render で `linkifyCommitMessage` (string.matchAll の O(n)
 * コスト) が全 commit 分実行されるため、computed で `(commits, baseUrl)` が変わったときだけ
 * 再計算する形に変える。row hover / 選択変更 等の再 render では再計算しない。 */
const commitMessageSegmentsByHash = computed(() => {
  const baseUrl = issueLinkBaseUrl.value;
  const map = new Map<string, CommitMessageSegment[]>();
  for (const node of layout.value.nodes) {
    map.set(node.commit.hash, linkifyCommitMessage(node.commit.message, baseUrl));
  }
  return map;
});

// active worktree の PR 一覧を 60 秒間隔で取得する。
// gozd の primary use case は「Claude / ユーザーが worktree で `gh pr create` する」ことであり、
// 既 push branch での `gh pr create` / `gh pr edit` / `gh pr comment` / `gh pr review` 等は
// local refs を動かさないため SSOT push 経路では到達不能。これらを UI に反映する唯一の経路は
// `gh pr list` の定期取得。scope は active worktree 1 個に限定するため負荷は 60 query/h で、
// 全 worktree fan-out の問題は発生しない (GH GraphQL 5000/h の 1.2%)。
const PR_LIST_POLL_INTERVAL_MS = 60_000;
const { pause: pausePrPolling, resume: resumePrPolling } = useIntervalFn(
  loadPrList,
  PR_LIST_POLL_INTERVAL_MS,
  { immediateCallback: false },
);

onMounted(() => {
  void loadPrList();
  void loadRepoIdentity();
});

// worktree 切り替え時に PR / repo identity 再取得 + interval を新 dir 基準に再スタート。
// 切替直後に間隔分待たされず、かつ古い dir のタイマーで二重発火しない。
//
// fetch 完了前の async 窓で旧 repo の identity / PR map が残ると、新 repo の commit が描画
// された瞬間に「新 repo の #N を旧 repo の URL にリンク」「新 branch を旧 PR バッジに紐付け」
// 等の cross-repo 事故が起きる。これを構造的に防ぐため、fetch 発射前に同期で空に倒す。
watch(
  () => worktreeStore.dir,
  () => {
    pausePrPolling();
    repoIdentity.value = { owner: "", repo: "" };
    prByBranch.value = new Map();
    void loadPrList();
    void loadRepoIdentity();
    resumePrPolling();
  },
);

/** グラフ描画の定数 */
const LANE_WIDTH = 16;
const ROW_HEIGHT = 24;
const DOT_RADIUS = 4;
const GRAPH_PADDING_X = 12;

/** Graph 列の幅 */
const graphColumnWidth = computed(
  () => GRAPH_PADDING_X + layout.value.maxLanes * LANE_WIDTH + GRAPH_PADDING_X,
);

/** グラフ全体の SVG 高さ */
const svgHeight = computed(() => layout.value.nodes.length * ROW_HEIGHT);

/** レーン番号 → X ピクセル座標 */
function laneX(lane: number): number {
  return GRAPH_PADDING_X + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** 行番号 → Y ピクセル座標（行の中央） */
function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * Working Tree 固定行 → HEAD コミットへの接続ダッシュ線パス。
 * lane 0 を垂直に降りて、HEAD の1行上からベジェ曲線で HEAD レーンへ合流する。
 * HEAD が row 0 の場合は直接接続する。
 */
const connectorPath = computed(() => {
  const head = headNode.value;
  if (head === undefined) return "";

  const x0 = laneX(0);
  const xHead = laneX(head.node.lane);
  const headIndex = head.index;
  const headY = rowY(headIndex);

  // HEAD が lane 0 にいる場合: 垂直直線のみ
  if (x0 === xHead) {
    return `M${x0},0L${x0},${headY}`;
  }

  // lane 0 を垂直に降りて、HEAD の1行上からベジェ曲線で合流。
  // HEAD が row 0 の場合は turnY = 0 となり、垂直部分なしで直接カーブする。
  const turnY = headIndex > 0 ? rowY(headIndex - 1) : 0;
  const span = headY - turnY;
  const d = span * 0.8;
  return `M${x0},0L${x0},${turnY}C${x0},${turnY + d} ${xHead},${headY - d} ${xHead},${headY}`;
});

/** ブランチの色パレット */
const COLORS = [
  "#4ec9b0", // teal
  "#569cd6", // blue
  "#c586c0", // purple
  "#ce9178", // orange
  "#dcdcaa", // yellow
  "#d16969", // red
  "#608b4e", // green
  "#9cdcfe", // light blue
];

function colorFor(index: number): string {
  return COLORS[index % COLORS.length];
}

/**
 * ラインセグメントの SVG パスを生成する。
 * 各セグメントは隣接する2行間なので、常に1行分の高さ。
 * 同じレーンなら垂直線、異なるレーンならベジェ曲線。
 */
function segmentPath(x1: number, y1: number, x2: number, y2: number): string {
  const px1 = laneX(x1);
  const py1 = rowY(y1);
  const px2 = laneX(x2);
  const py2 = rowY(y2);

  if (px1 === px2) {
    return `M${px1},${py1}L${px2},${py2}`;
  }

  // ベジェ曲線で滑らかにレーン移動
  const d = ROW_HEIGHT * 0.8;
  return `M${px1},${py1}C${px1},${py1 + d} ${px2},${py2 - d} ${px2},${py2}`;
}

function isMergeCommit(commit: GitCommit): boolean {
  return commit.parents.length > 1;
}

/** HEAD を含むかどうか */
function hasHead(refs: string[]): boolean {
  return refs.includes("HEAD");
}

/**
 * refs 配列から HEAD が指すカレントブランチ名を取得する。
 * git log の %D は "HEAD -> branch" をパース後 ["HEAD", "branch", ...] の順になるため、
 * HEAD の直後の非 origin/非 tag エントリがカレントブランチ。
 */
function findCurrentBranch(refs: string[]): string | undefined {
  const headIdx = refs.indexOf("HEAD");
  if (headIdx === -1) return undefined;
  const next = refs[headIdx + 1];
  if (next && !next.startsWith("origin/") && !next.startsWith("tag:")) {
    return next;
  }
  return undefined;
}

/**
 * refs 配列を表示用に整理する。
 * - HEAD / origin/HEAD は除外（HEAD は → マーカーで別途表示）
 * - origin/xxx とローカル xxx が一致する場合は統合して synced タイプにする
 * - HEAD が指すブランチは current、defaultBranch と一致するブランチは default タイプにする
 */
function computeDisplayRefs(
  refs: string[],
  currentBranchName?: string,
  defaultBranchName?: string,
  outOfSyncSet?: Set<string>,
): DisplayRef[] {
  const filtered = refs.filter((r) => r !== "HEAD" && r !== "origin/HEAD");
  const locals = new Set(filtered.filter((r) => !r.startsWith("origin/") && !r.startsWith("tag:")));
  const remotes = new Set(
    filtered.filter((r) => r.startsWith("origin/")).map((r) => r.slice("origin/".length)),
  );
  const tags = filtered.filter((r) => r.startsWith("tag:"));

  const result: DisplayRef[] = [];

  // ローカルブランチ
  for (const local of locals) {
    const isSynced = remotes.has(local);
    if (isSynced) remotes.delete(local);
    const type = isSynced ? "synced" : "local";
    const isCurrent = local === currentBranchName;
    const isDefault = local === defaultBranchName;
    const isOutOfSync = !isSynced && (outOfSyncSet?.has(local) ?? false);
    result.push({ label: local, type, isSynced, isOutOfSync, isCurrent, isDefault });
  }

  // origin のみ（ローカルに対応がない）
  for (const remote of remotes) {
    const isCurrent = remote === currentBranchName;
    const isDefault = remote === defaultBranchName;
    const isOutOfSync = outOfSyncSet?.has(remote) ?? false;
    result.push({
      label: `origin/${remote}`,
      type: "remote",
      isSynced: false,
      isOutOfSync,
      isCurrent,
      isDefault,
    });
  }

  // タグ
  for (const tag of tags) {
    result.push({
      label: tag.slice("tag:".length),
      type: "tag",
      isSynced: false,
      isOutOfSync: false,
      isCurrent: false,
      isDefault: false,
    });
  }

  return result;
}

/** 日付フォーマット（短い形式） */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = date.toLocaleString("en", { month: "short" });
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

/** 詳細ペインの幅 */
const DETAIL_MIN_WIDTH = 200;
const GRAPH_LIST_MIN_WIDTH = 400;
/** ResizeHandle の幅 */
const DETAIL_HANDLE_WIDTH = 8;
const detailWidth = ref(320);
const detailOpen = ref(true);

// コンテナ幅縮小時に detailWidth をクランプし、収まらなければ自動で閉じる
// rootWidth が 0（マウント前）のときはスキップ。
// 書き換え対象の detailOpen / detailWidth は source に含めない
watch(
  rootWidth,
  (width) => {
    if (!detailOpen.value || width === 0) return;
    const available = width - GRAPH_LIST_MIN_WIDTH - DETAIL_HANDLE_WIDTH;
    if (available < DETAIL_MIN_WIDTH) {
      detailOpen.value = false;
      return;
    }
    if (detailWidth.value > available) {
      detailWidth.value = Math.max(DETAIL_MIN_WIDTH, available);
    }
  },
  { immediate: true },
);

const graphListRef = ref<HTMLElement | null>(null);
const scrollContainer = ref<HTMLElement | null>(null);

/** 左ペインは flex-1 で自動幅のため、DOM 実測値を返す */
function getGraphListSize(): number {
  const el = scrollContainer.value ?? graphListRef.value;
  return el?.offsetWidth ?? GRAPH_LIST_MIN_WIDTH;
}

/** 現在選択中のノードのインデックス。範囲選択中は compareHash（移動端）を返す */
function selectedIndex(): number {
  const { compareHash } = gitGraphStore;
  const hash = compareHash ?? gitGraphStore.selectedHash;
  return gitGraphStore.hashToIndex.get(hash) ?? -1;
}

/** 選択を Uncommitted Changes に戻し、HEAD コミット付近にスクロール */
function scrollHeadIntoView() {
  const index = layout.value.nodes.findIndex((n) => n.commit.refs.includes("HEAD"));
  if (index === -1) return;
  gitGraphStore.resetSelection();
  scrollToCenter(index);
}

/** 指定行をビューポート中央にスクロール */
function scrollToCenter(index: number) {
  const container = scrollContainer.value;
  if (!container) return;
  const rowCenter = index * ROW_HEIGHT + ROW_HEIGHT / 2;
  container.scrollTop = rowCenter - container.clientHeight / 2;
}

/** 選択行をビューポート内にスクロール */
function scrollToIndex(index: number) {
  const container = scrollContainer.value;
  if (!container) return;
  const rowTop = index * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  if (rowTop < container.scrollTop) {
    container.scrollTop = rowTop;
  } else if (rowBottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = rowBottom - container.clientHeight;
  }
}

/** ビューポートに収まる行数 */
function pageSize(): number {
  const container = scrollContainer.value;
  if (!container) return 1;
  return Math.max(1, Math.floor(container.clientHeight / ROW_HEIGHT));
}

function onKeydown(e: KeyboardEvent) {
  const nodes = layout.value.nodes;
  if (nodes.length === 0) return;

  const isUp = e.key === "ArrowUp" || e.key === "PageUp";
  const isDown = e.key === "ArrowDown" || e.key === "PageDown";
  if (!isUp && !isDown) return;
  e.preventDefault();

  const isPage = e.key === "PageUp" || e.key === "PageDown";
  const step = isPage ? pageSize() : 1;
  const current = selectedIndex();

  // 移動端が Working Tree にある場合（単一選択 or 範囲選択の compareHash が UNCOMMITTED_HASH）
  if (current === -1) {
    if (isUp) {
      scrollToIndex(0);
      return;
    }
    const next = Math.min(step - 1, nodes.length - 1);
    const hash = nodes[next].commit.hash;
    if (e.shiftKey) {
      gitGraphStore.selectCompare(hash);
    } else {
      gitGraphStore.select(hash);
    }
    scrollToIndex(next);
    return;
  }

  // コミット行先頭付近で上移動 → Working Tree へ
  if (isUp && current !== -1 && current - step < 0) {
    if (e.shiftKey) {
      gitGraphStore.selectCompare(UNCOMMITTED_HASH);
    } else {
      gitGraphStore.select(UNCOMMITTED_HASH);
    }
    return;
  }

  let next: number;

  if (isUp) {
    next = current - step;
  } else {
    next = Math.min(nodes.length - 1, current + step);
  }

  if (e.shiftKey) {
    gitGraphStore.selectCompare(nodes[next].commit.hash);
  } else {
    gitGraphStore.select(nodes[next].commit.hash);
  }
  scrollToIndex(next);
}

function onRowClick(hash: string, e: MouseEvent) {
  // macOS WebKit は control+click を button=0 の click として dispatch する
  // (webkit bugzilla 52174)。contextmenu と一緒に通常 click も発火するため、control+click は
  // context menu trigger の意図として選択変更には倒さず contextmenu 経路に委譲する。
  if (e.ctrlKey) return;
  if (e.shiftKey) {
    gitGraphStore.selectCompare(hash);
  } else {
    gitGraphStore.select(hash);
  }
}

// --- commit 行の右クリックメニュー (Reset mixed) ---

const { open: openCommitContextMenu } = useCommitContextMenu();

type PendingCommitMenu = {
  anchorEl: HTMLElement;
  dir: string;
  hash: string;
  x: number;
  y: number;
};

/**
 * 右クリックで積まれる pending open。次の `pointerup` で処理して open する。連打時は最後の
 * 右クリックが pending を上書きする (popover singleton の openState 上書き semantics と整合)。
 */
const pendingCommitMenu = ref<PendingCommitMenu | null>(null);

/**
 * window 全体に常設する `pointerup` capture listener。pending が積まれていれば消化して open する。
 *
 * **不変条件 (実装変更時に必読、`useCommitContextMenu.ts` の docstring と同期して維持する)**:
 * - `setTimeout(0)` / `requestAnimationFrame` / `queueMicrotask` 等の defer は WebKit (WebPage) の
 *   `popover="auto"` light-dismiss を **抜けない** (実機検証済)。続く mouseup が popover に到達して
 *   即 dismiss される (whatwg/html#10905)
 * - `pointerup` を `capture: true` で window に貼ると、popover が show される **前** に listener が
 *   pointerup を消化する → 続く mouseup は popover open 前の press cycle として扱われ
 *   light-dismiss の対象外になる。`{ capture: true }` を外したり pointerdown / mousedown 経路に
 *   変えてはならない
 * - `event.button` filter を入れてはならない。macOS WebKit は control+click を button=0 として
 *   dispatch する (webkit bugzilla 52174) ため、control+click 経由の native context menu 経路で
 *   menu が開かなくなる。pending ref そのものが「直前に contextmenu があった」flag を兼ねる
 * - `pointerdown` で pending を reset する経路を追加してはならない。右クリック sequence
 *   (pointerdown → contextmenu → pointerup) では右ボタン pointerdown が `onCommitContextMenu` の
 *   pending 積みより前に終わるため単体では破綻しないが、pending が積まれた状態で別経路の
 *   pointerdown (例: 左 click) が来ると pending を即消去し、次の pointerup での消化が起きなく
 *   なる。状態遷移を pointerup のみで完結させる現設計を維持する
 * - keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火しないため
 *   menu は開かない (本対応の責務外)
 *
 * `useEventListener` を setup 直下で呼ぶことで effect scope に紐付き、unmount / HMR で自動 cleanup
 * される。
 */
useEventListener(
  window,
  "pointerup",
  () => {
    const pending = pendingCommitMenu.value;
    if (!pending) return;
    pendingCommitMenu.value = null;
    if (!pending.anchorEl.isConnected) {
      notify.debug("[CommitContextMenu] anchor disconnected before open, skipping", {
        hash: pending.hash,
      });
      return;
    }
    openCommitContextMenu(pending.anchorEl, {
      dir: pending.dir,
      hash: pending.hash,
      x: pending.x,
      y: pending.y,
    });
  },
  { capture: true },
);

/**
 * commit 行の右クリックで pending を積む。`dir` / `hash` は本関数の同期実行時点で snapshot し、
 * pointerup 待機中に worktree 切替 / commit 選択切替 / git log 再取得が起きても、その右クリック
 * 時点の値を popover context に焼き付ける (Working Tree 行はメニュー対象外なので hash は必ず実 commit)。
 */
function onCommitContextMenu(hash: string, e: MouseEvent) {
  if (!(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  const dir = worktreeStore.dir;
  if (dir === undefined) {
    notify.debug("[CommitContextMenu] no active worktree, skipping", { hash });
    return;
  }
  pendingCommitMenu.value = {
    anchorEl: e.currentTarget,
    dir,
    hash,
    x: e.clientX,
    y: e.clientY,
  };
}

/**
 * 行のハイライトクラスを返す。
 *
 * 単一選択 / 範囲選択どちらも同一の単色背景でハイライトする。
 * 「実 diff 対象 commit」の強調は SVG の dot 側で行うため、ここでは選択範囲そのものの提示に専念する。
 */
function rowHighlightClass(hash: string): string {
  if (isSelectedRow(hash)) {
    return "bg-blue-900/30 hover:bg-blue-900/40";
  }
  return "hover:bg-zinc-800/60";
}

/**
 * 単一選択 / 範囲選択の visual range（青背景の対象行）を判定する。
 *
 * activeCommitHashes（実 diff 対象 = first-parent walk 結果）には依存させない。
 * activeCommitHashes は dot 強調用 (isActiveDot) に限定し、行 background は
 * 「ユーザーが shift+click で選んだ範囲そのもの」を素直に表現する。
 * Working Tree 端は activeCommitHashes に含まれないため、ここで明示的にハイライト対象に含める。
 */
function isSelectedRow(hash: string): boolean {
  const { selectedHash, compareHash } = gitGraphStore;
  if (compareHash === null) {
    return hash === selectedHash;
  }
  return hash === selectedHash || hash === compareHash || isInRange(hash);
}

/**
 * 範囲選択の min/max インデックス。compareHash が null なら undefined。
 * UNCOMMITTED_HASH は layout.nodes に含まれないため -1 として扱う。
 */
const rangeIndices = computed<{ min: number; max: number } | undefined>(() => {
  const { selectedHash, compareHash } = gitGraphStore;
  if (compareHash === null) return undefined;
  const map = gitGraphStore.hashToIndex;
  const selectedIdx = selectedHash === UNCOMMITTED_HASH ? -1 : map.get(selectedHash);
  const compareIdx = compareHash === UNCOMMITTED_HASH ? -1 : map.get(compareHash);
  if (selectedIdx === undefined || compareIdx === undefined) return undefined;
  return { min: Math.min(selectedIdx, compareIdx), max: Math.max(selectedIdx, compareIdx) };
});

/** 2点間の範囲内にあるかどうか */
function isInRange(hash: string): boolean {
  const range = rangeIndices.value;
  if (!range) return false;
  const idx = gitGraphStore.hashToIndex.get(hash);
  if (idx === undefined) return false;
  return idx > range.min && idx < range.max;
}

/**
 * SVG の dot を branch color で塗りつぶして強調する対象かどうか。
 *
 * - 単一選択時: 選択中の commit
 * - 範囲選択時: first-parent walk で得た実 diff 対象 commit（activeCommitHashes）
 */
function isActiveDot(hash: string): boolean {
  const { selectedHash, compareHash, activeCommitHashes } = gitGraphStore;
  if (compareHash === null) {
    return hash === selectedHash;
  }
  return activeCommitHashes?.has(hash) ?? false;
}

/**
 * Working Tree 行の dot をハイライトするかどうか。
 * 単一 Working Tree 選択 / 範囲選択の片端が Working Tree のとき teal で塗りつぶす。
 */
const isWorkingTreeActive = computed(
  () =>
    gitGraphStore.selectedHash === UNCOMMITTED_HASH ||
    gitGraphStore.compareHash === UNCOMMITTED_HASH,
);
</script>

<template>
  <div
    ref="root"
    class="flex size-full flex-col overflow-hidden bg-zinc-900 text-zinc-300 select-none"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-commit-horizontal] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Git Graph</span>
      <span v-if="commits.length > 0" class="text-xs text-zinc-500">({{ commits.length }})</span>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="firstParentOnly ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'"
        :aria-pressed="firstParentOnly"
        @click="firstParentOnly = !firstParentOnly"
      >
        First Parent
      </button>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="
          currentBranchOnly ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'
        "
        :aria-pressed="currentBranchOnly"
        title="Hide default branch and show current branch only"
        @click="currentBranchOnly = !currentBranchOnly"
      >
        Current Branch
      </button>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="
          sortMode === 'topo' ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'
        "
        :aria-pressed="sortMode === 'topo'"
        @click="sortMode = sortMode === 'date' ? 'topo' : 'date'"
      >
        {{ sortMode === "date" ? "Date Order" : "Topo Order" }}
      </button>
      <button
        class="rounded-sm px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
        @click="scrollHeadIntoView"
      >
        Scroll to HEAD
      </button>
      <button
        class="ml-auto rounded-sm px-1.5 py-0.5 text-[10px]"
        :class="detailOpen ? 'bg-blue-800 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'"
        :aria-pressed="detailOpen"
        title="Toggle commit detail"
        aria-label="Toggle commit detail"
        @click="detailOpen = !detailOpen"
      >
        <span class="icon-[lucide--panel-right] size-3.5" />
      </button>
    </div>

    <!-- Graph list + Detail pane (horizontal split) -->
    <div class="flex min-h-0 flex-1">
      <!-- Graph list -->
      <div
        ref="graphListRef"
        class="flex min-w-0 flex-1 flex-col outline-none"
        tabindex="0"
        @keydown="onKeydown"
      >
        <!-- Working Tree 固定行: スクロール領域の外に配置 -->
        <div
          class="_graph-row relative flex shrink-0 items-center border-b border-zinc-700/50 text-xs"
          :class="rowHighlightClass(UNCOMMITTED_HASH)"
          :style="{ height: `${ROW_HEIGHT}px` }"
          @click="onRowClick(UNCOMMITTED_HASH, $event)"
        >
          <!-- Working Tree 行の SVG: lane 0 にドット、下端へダッシュ線 -->
          <svg
            class="pointer-events-none absolute top-0 left-0"
            :width="graphColumnWidth"
            :height="ROW_HEIGHT"
          >
            <circle
              :cx="laneX(0)"
              :cy="ROW_HEIGHT / 2"
              :r="isWorkingTreeActive ? DOT_RADIUS + 1 : DOT_RADIUS"
              :fill="isWorkingTreeActive ? colorFor(headColor) : '#1c1c1c'"
              :stroke="colorFor(headColor)"
              stroke-width="2"
            />
            <line
              :x1="laneX(0)"
              :y1="ROW_HEIGHT / 2 + DOT_RADIUS"
              :x2="laneX(0)"
              :y2="ROW_HEIGHT"
              :stroke="colorFor(headColor)"
              stroke-width="2"
              stroke-dasharray="4 2"
            />
          </svg>

          <!-- Graph spacer -->
          <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

          <!-- Description -->
          <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
            <span
              v-if="uncommittedChangeCount === 0"
              class="truncate font-semibold text-zinc-400 italic"
            >
              Working Tree (Clean)
            </span>
            <StatusIcons v-else :entries="statusIcons" icon-size="size-4" />
          </div>
        </div>

        <!-- スクロール可能なコミットリスト -->
        <div ref="scrollContainer" class="min-h-0 flex-1 overflow-auto">
          <div class="relative" :style="{ minHeight: `${svgHeight}px` }">
            <!-- Graph SVG overlay -->
            <svg
              class="pointer-events-none absolute top-0 left-0"
              :width="graphColumnWidth"
              :height="svgHeight"
            >
              <!-- Working Tree → HEAD 接続ダッシュ線（lane 0 上端から HEAD レーンへ） -->
              <path
                v-if="connectorPath"
                :d="connectorPath"
                fill="none"
                :stroke="colorFor(headColor)"
                stroke-width="2"
                stroke-dasharray="4 2"
              />
              <!-- ラインセグメント -->
              <path
                v-for="(seg, si) in layout.lines"
                :key="`seg-${si}`"
                :d="segmentPath(seg.x1, seg.y1, seg.x2, seg.y2)"
                fill="none"
                :stroke="colorFor(seg.color)"
                stroke-width="2"
              />
              <!-- コミットドット -->
              <circle
                v-for="(node, row) in layout.nodes"
                :key="`dot-${node.commit.hash}`"
                :cx="laneX(node.lane)"
                :cy="rowY(row)"
                :r="isActiveDot(node.commit.hash) ? DOT_RADIUS + 1 : DOT_RADIUS"
                :fill="isActiveDot(node.commit.hash) ? colorFor(node.color) : 'currentColor'"
                :stroke="colorFor(node.color)"
                :stroke-width="isActiveDot(node.commit.hash) ? 2 : 1.5"
                class="text-zinc-900"
              />
            </svg>

            <!-- Commit table rows -->
            <div
              v-for="node in layout.nodes"
              :key="node.commit.hash"
              class="_graph-row relative flex items-center text-xs"
              :class="rowHighlightClass(node.commit.hash)"
              :style="{ height: `${ROW_HEIGHT}px` }"
              @click="onRowClick(node.commit.hash, $event)"
              @contextmenu="onCommitContextMenu(node.commit.hash, $event)"
            >
              <!-- Graph spacer -->
              <div class="shrink-0" :style="{ width: `${graphColumnWidth}px` }" />

              <!-- HEAD marker: グラフ列の右端に absolute 配置。レイアウトに影響しない -->
              <span
                v-if="hasHead(node.commit.refs)"
                class="absolute text-yellow-500"
                :style="{
                  left: `${graphColumnWidth}px`,
                  transform: 'translateX(calc(-100% - 4px))',
                }"
                title="HEAD"
              >
                →
              </span>

              <!-- Description -->
              <div class="flex min-w-0 flex-1 items-center gap-1 truncate pr-2">
                <span
                  v-if="isMergeCommit(node.commit)"
                  class="icon-[lucide--git-merge] size-3.5 shrink-0 text-zinc-500"
                />
                <RefBadge
                  v-for="displayRef in computeDisplayRefs(
                    node.commit.refs,
                    currentBranch,
                    defaultBranch,
                    outOfSyncBranches,
                  )"
                  :key="`${displayRef.type}:${displayRef.label}`"
                  :display-ref="displayRef"
                  :pr-by-branch="prByBranch"
                />
                <span class="truncate">
                  <CommitSegmentList
                    :segments="commitMessageSegmentsByHash.get(node.commit.hash) ?? []"
                  />
                </span>
              </div>

              <!-- Date -->
              <div class="w-28 shrink-0 text-zinc-500">
                {{ formatDate(node.commit.date) }}
              </div>

              <!-- Author -->
              <div class="w-28 shrink-0 truncate text-zinc-500">
                {{ node.commit.author }}
              </div>

              <!-- Commit hash -->
              <div class="w-16 shrink-0 font-mono text-zinc-600">
                {{ node.commit.shortHash }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Detail pane -->
      <template v-if="detailOpen">
        <ResizeHandle
          v-model:after-size="detailWidth"
          direction="horizontal"
          :before-min-size="GRAPH_LIST_MIN_WIDTH"
          :after-min-size="DETAIL_MIN_WIDTH"
          :get-before-size="getGraphListSize"
        />
        <div
          class="shrink-0 overflow-hidden border-l border-zinc-700"
          :style="{ width: `${detailWidth}px` }"
        >
          <CommitDetailPane :commits="gitGraphStore.selectedCommits" :base-url="issueLinkBaseUrl" />
        </div>
      </template>
    </div>

    <!-- commit 行の右クリックメニュー (Reset mixed) -->
    <CommitContextMenu />
  </div>
</template>
