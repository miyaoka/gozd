<doc lang="md">
Git commit graph pane。active worktree のブランチとデフォルトブランチの commit graph を表示する。
git log の取得と各部の合成を担うコンテナで、描画自体は持たない。

## HEAD スクロールが間接経路な理由

「HEAD 行へスクロール」は data 取得側が要求を出すだけで、実スクロールは scroll DOM を持つ描画側が行う。
両者を直接呼び合わせると data と DOM の所有が絡むため、store の signal 1 本で疎結合にしている。

## 履歴の途切れ表示

全ブランチ表示で HEAD が新しい順 maxCount ウィンドウから押し出される場合、native (`GitOps.log`) が
HEAD-only walk を末尾 append し境界に `truncatedAbove` を立てる。renderer はその境界に gap 行を挿入する。
</doc>

<script setup lang="ts">
import { SortMode, type GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useElementSize, useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { ResizeHandle } from "../layout";
import { ghErrorMessage, rpcGitPrList } from "../palette";
import type { BranchChangePayload, FsWatchReadyPayload, RemoteRefsChangePayload } from "../sidebar";
import type { GitStatusChangePayload } from "../worktree";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import CommitDetailPane from "./CommitDetailPane.vue";
import { CommitContextMenu, useCommitContextMenuTrigger } from "./features/commit-context-menu";
import { CommitGraphList } from "./features/commit-list";
import GitGraphToolbar from "./GitGraphToolbar.vue";
import { buildRepoBaseUrl } from "./linkifyCommitMessage";
import { rpcGitGithubIdentity, rpcGitLog } from "./rpc";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrListStore } from "./usePrListStore";

const rootRef = useTemplateRef<HTMLElement>("root");
const { width: rootWidth } = useElementSize(rootRef);
const worktreeStore = useWorktreeStore();
const gitGraphStore = useGitGraphStore();
const prListStore = usePrListStore();
const notify = useNotificationStore();
const repoStore = useRepoStore();
const { prByBranch } = storeToRefs(prListStore);
const { commits } = storeToRefs(gitGraphStore);

const defaultBranch = ref<string | undefined>();
const firstParentOnly = ref(false);
// SSOT: proto の SortMode enum をそのまま UI 状態として持ち、RPC 呼び出しで変換不要にする。
const sortMode = ref<SortMode>(SortMode.SORT_MODE_DATE);
const currentBranchOnly = ref(false);

/** refs 配列に "HEAD" を持つコミットを探す */
function findHeadCommit(rawCommits: GitCommit[]): GitCommit | undefined {
  return rawCommits.find((c) => c.refs.includes("HEAD"));
}

// 以下 3 つの「前回値」は **active worktree dir に対する不変条件** として保持する。
// 全 worktree watch / 全 worktree push 設計では、別 worktree の gitStatusChange が active dir の
// 前回値を踏み潰さないよう、push handler 側で必ず `payload.dir === worktreeStore.dir` を確認して
// からこれらを更新する。worktree 切替時 (loadLog) には新 dir の取得結果でリセットする。

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
 * counter にすると `count === 0` で「全 in-flight 完了」を厳密に判定でき、pending の消費
 * タイミングが「最後の loadLog の finally」に固定される。 */
let loadLogInFlightCount = 0;
/** in-flight 中に `scheduleLoadLog` が来たかを示す 1 bit。`loadLogInFlightCount === 0` に落ちた時点で
 * 1 度だけ trailing fetch を発射する。burst N 発火を最大 2 fetch に集約する。 */
let loadLogScheduled = false;

/** @returns 世代チェックを通過して state を更新した場合 true */
async function loadLog(): Promise<boolean> {
  loadLogInFlightCount += 1;
  try {
    return await runLoadLog();
  } finally {
    loadLogInFlightCount -= 1;
    // 最後の in-flight が完了したタイミングでだけ trailing を発射する。並走 loadLog の途中で
    // 抜けた finally では pending を消費せず、最終の 1 つに集約する。
    if (loadLogInFlightCount === 0 && loadLogScheduled) {
      loadLogScheduled = false;
      // ここで await すると caller の世代に乗らずタイミングが歪むため、fire-and-forget。
      void loadLog();
    }
  }
}

/** push burst (`gitStatusChange` + `remoteRefsChange` + `branchChange` 連射) からの fire-and-forget
 * 経路。in-flight な loadLog があれば trailing 1 fetch にまとめ、なければ即 loadLog する。
 *
 * `refs/remotes/*` 1 回の write で `gitStatusChange` + `remoteRefsChange` が両方発射され、さらに
 * `packed-refs` だと `branchChange` も伴って同じ burst 内で `rpcGitLog` が 2〜3 回並列発射される。
 * `loadLogGen` の世代管理は到達した結果を捨てる事後防衛で、`scheduleLoadLog` は発射そのものを抑止する
 * 事前防衛。明示 trigger 由来の `await loadLog()` も `loadLogInFlightCount > 0` を立てるため、同 burst 内の
 * `scheduleLoadLog` は trailing 側に畳まれる。 */
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
  // rpcGitLog は native の `commandFailed` / `launchFailed` / `commandNotFound` を RPC error として
  // throw し得る。silent 化すると graph が空のまま気づけなくなるため tryCatch + notify。
  const rpcResult = await tryCatch(
    rpcGitLog({
      dir,
      maxCount: 200,
      firstParentOnly: firstParentOnly.value,
      currentBranchOnly: currentBranchOnly.value,
      sortMode: sortMode.value,
    }),
  );
  if (gen !== loadLogGen) return false;
  if (!rpcResult.ok) {
    // 失敗時は graph state を空に倒す。前回 worktree 成功時の commits / selection が残ると、
    // 右クリックメニューの dir snapshot は現 worktree という不整合が起き、reset --mixed 等で別 repo に
    // 対する破壊操作が走る事故源になる。fail-soft で空状態に揃え、notify.error で観察可能化。
    notify.error("Failed to load git graph", rpcResult.error);
    commits.value = [];
    defaultBranch.value = undefined;
    lastHead = "";
    lastBranchHead = "";
    lastUpstream = "";
    gitGraphStore.resetSelection();
    return false;
  }
  const result = rpcResult.value;

  const loaded = result.commits;
  commits.value = loaded;
  defaultBranch.value = result.defaultBranch === "" ? undefined : result.defaultBranch;
  const headCommit = findHeadCommit(loaded);
  lastHead = headCommit?.hash ?? "";
  // `lastBranchHead` も loadLog の結果に合わせて更新する。これをやらないと worktree 切替後の最初の
  // gitStatusChange push で branchHeadChanged が偽陽性で立ち、冗長な 2 度目の loadLog が走る。
  // SSOT: `result.branchHead` は native の `git symbolic-ref --short HEAD` 由来で、
  // `gitStatusChange` push の `branchHead` (porcelain v2 `# branch.head` 由来) と同一 semantics。
  lastBranchHead = result.branchHead;

  // 選択中・比較中のコミットが一覧から消えた場合はクリア
  const { selectedHash, compareHash } = gitGraphStore;
  const isStale = (hash: string | null): boolean =>
    hash !== null && hash !== UNCOMMITTED_HASH && !loaded.some((c) => c.hash === hash);
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
    // 3 つの closure 変数すべてを reset する。loadLog の await 中に新 worktree の gitStatusChange が
    // 到達すると、旧 worktree の lastHead / lastBranchHead と比較して偽陽性を立て追加 loadLog が走る。
    lastHead = "";
    lastBranchHead = "";
    lastUpstream = "";
    const updated = await loadLog();
    if (!updated) return;
    gitGraphStore.requestScrollToHead();
  },
);

// firstParentOnly / sortMode / currentBranchOnly 切替時に再取得
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

// HEAD 変更（コミット、リベース等）/ branch 名変更（git branch -m）/ upstream 変更（push、fetch）
// を検知して git log を再取得する。`git branch -m` は OID を変えないため、head ハッシュだけで判定すると
// rename が漏れる。branchHead（HEAD が指す branch 名）の変化も発火条件に含める。
const disposeGitStatus = onMessage<GitStatusChangePayload>(
  "gitStatusChange",
  ({ dir, head, branchHead, upstream }) => {
    // active worktree dir 以外の push は無視。closure 変数は active dir の不変条件として保持する。
    if (dir !== worktreeStore.dir) return;
    const upstreamKey = upstream !== undefined ? `${upstream.ahead}/${upstream.behind}` : "";
    const headChanged = head !== "" && head !== lastHead;
    const branchHeadChanged = branchHead !== lastBranchHead;
    const upstreamChanged = upstreamKey !== lastUpstream;

    if (headChanged) lastHead = head;
    if (branchHeadChanged) lastBranchHead = branchHead;
    if (upstreamChanged) lastUpstream = upstreamKey;

    // headChanged は HEAD コミット位置にスクロールしたいため await loadLog で結果を待つ。
    // branchHead / upstream 変化のみの場合は scroll 不要なので scheduleLoadLog で coalesce させる。
    if (headChanged) {
      void (async () => {
        const updated = await loadLog();
        if (!updated) return;
        gitGraphStore.requestScrollToHead();
      })();
    } else if (branchHeadChanged || upstreamChanged) {
      scheduleLoadLog();
    }
    // 本 else if に到達する `upstreamChanged` は `refs/remotes/origin/<current-branch>` の書き換えに
    // 限られ (HEAD 移動は headChanged 経路)、同 burst で必ず `remoteRefsChange` が発射される。
    // よって `loadPrList` は `remoteRefsChange` handler 側に集約する (両方で呼ぶと `gh pr list` 2 連射)。
  },
);
onUnmounted(disposeGitStatus);

// ブランチ ref の変更 (作成・削除・リネーム) は repo 共有の commonGitDir で起き、同 repo の worktree 群の
// うち primary 1 つだけが push される。`isSameRepoAsActive` で active と同じ repo か判定。
const disposeBranchChange = onMessage<BranchChangePayload>("branchChange", ({ dir }) => {
  if (!repoStore.isSameRepoAsActive(dir)) return;
  scheduleLoadLog();
});
onUnmounted(disposeBranchChange);

// `git fetch` / `git push` でローカルの remote-tracking ref が動いたとき発火する。PR 一覧の即時反映も
// ここで取り直す。`loadPrList` は本 handler を SSOT 発火元とする (current branch ref の書き換えでも本
// handler が同 burst で必ず発射されるため、`gitStatusChange` 側と両方呼ぶと `gh pr list` 2 連射になる)。
const disposeRemoteRefsChange = onMessage<RemoteRefsChangePayload>(
  "remoteRefsChange",
  ({ dir }) => {
    if (!repoStore.isSameRepoAsActive(dir)) return;
    scheduleLoadLog();
    void loadPrList();
  },
);
onUnmounted(disposeRemoteRefsChange);

// `useFsWatchSync` の `rpcFsWatch` 完了直後に発射される再同期通知。watch 起動往復中の FS 変化を
// 救済するため、1 度だけ git log を取り直す。payload.dir は repo の代表 worktree (active とは限らない)。
const disposeFsWatchReady = onMessage<FsWatchReadyPayload>("fsWatchReady", ({ dir }) => {
  if (!repoStore.isSameRepoAsActive(dir)) return;
  scheduleLoadLog();
});
onUnmounted(disposeFsWatchReady);

// --- PR 情報（非同期で後追い取得。SSOT は `usePrListStore`） ---

/** loadPrList の世代管理。並行実行で古いレスポンスが後着して上書きするのを防ぐ */
let loadPrGen = 0;

/** PR 一覧を取得して prListStore を更新する。失敗時は前回値を保持しつつ notify.error で告知する。 */
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
  prListStore.setPrs(res.prs);
}

// --- GitHub repo identity (コミットメッセージ `#N` リンク化の SSOT) ---

/** active worktree の origin remote を parse した `(owner, repo)`。worktree 切替時に 1 回だけ取得。 */
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
    // launch failure は git CLI 解決失敗 (PATH 不在等) のみ。remote 未設定 / 非 github は native 側で
    // 空文字 + stderr ログに倒すため、ここには来ない。
    notify.error("Failed to load GitHub identity", result.error);
    return;
  }
  repoIdentity.value = { owner: result.value.owner, repo: result.value.repo };
}

/** GitHub repo base URL (`https://github.com/<owner>/<repo>`)。remote 未設定 / 非 github.com は undefined。 */
const issueLinkBaseUrl = computed(() => buildRepoBaseUrl(repoIdentity.value));

// active worktree の PR 一覧を 60 秒間隔で取得する。既 push branch での `gh pr create` / `edit` /
// `comment` 等は local refs を動かさず SSOT push 経路では到達不能なため、これを反映する唯一の経路。
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
// fetch 完了前の async 窓で旧 repo の identity / PR map が残ると cross-repo 事故が起きるため、
// fetch 発射前に同期で空に倒す。
watch(
  () => worktreeStore.dir,
  () => {
    pausePrPolling();
    repoIdentity.value = { owner: "", repo: "" };
    prListStore.clear();
    void loadPrList();
    void loadRepoIdentity();
    resumePrPolling();
  },
);

// --- 詳細ペイン (右) の開閉 / リサイズ ---

const DETAIL_MIN_WIDTH = 200;
const GRAPH_LIST_MIN_WIDTH = 400;
/** ResizeHandle の幅 */
const DETAIL_HANDLE_WIDTH = 8;
const detailWidth = ref(320);
const detailOpen = ref(true);

// コンテナ幅縮小時に detailWidth をクランプし、収まらなければ自動で閉じる。
// rootWidth が 0（マウント前）のときはスキップ。書き換え対象の detailOpen / detailWidth は source に含めない。
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

/** graph list (左ペイン) の現在幅。root 幅から detail + handle を引いて導出する
 * (detail open 時のみ handle が存在し get-before-size が呼ばれる)。 */
function getGraphListSize(): number {
  return Math.max(0, rootWidth.value - detailWidth.value - DETAIL_HANDLE_WIDTH);
}

// --- commit 行の右クリックメニュー (Reset mixed) ---

const { requestOpen } = useCommitContextMenuTrigger();

/** CommitGraphList から上がってくる右クリック。dir を snapshot してメニューの表示を要求する
 * (working tree 行はメニュー対象外なので hash は必ず実 commit)。 */
function onCommitContextmenu(payload: {
  hash: string;
  anchorEl: HTMLElement;
  x: number;
  y: number;
}) {
  const dir = worktreeStore.dir;
  if (dir === undefined) {
    notify.debug("[CommitContextMenu] no active worktree, skipping", { hash: payload.hash });
    return;
  }
  requestOpen(payload.anchorEl, { dir, hash: payload.hash, x: payload.x, y: payload.y });
}
</script>

<template>
  <div ref="root" class="flex size-full flex-col overflow-hidden bg-background text-foreground">
    <GitGraphToolbar
      v-model:first-parent-only="firstParentOnly"
      v-model:current-branch-only="currentBranchOnly"
      v-model:sort-mode="sortMode"
      v-model:detail-open="detailOpen"
      :commit-count="commits.length"
      @scroll-to-head="gitGraphStore.requestScrollToHead()"
    />

    <!-- Graph list + Detail pane (horizontal split) -->
    <div class="flex min-h-0 flex-1">
      <CommitGraphList
        :default-branch="defaultBranch"
        :issue-link-base-url="issueLinkBaseUrl"
        :pr-by-branch="prByBranch"
        @commit-contextmenu="onCommitContextmenu"
      />

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
          class="shrink-0 overflow-hidden border-l border-border"
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
