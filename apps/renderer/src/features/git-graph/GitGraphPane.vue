<doc lang="md">
Git commit graph pane。active worktree の commit graph を表示する。walk の始点 ref 範囲は
toolbar の branch scope (current / default / all) で切替可能。git log の取得と各部の合成を担う
コンテナで、描画自体は持たない。

## HEAD スクロールが間接経路な理由

「HEAD 行へスクロール」は data 取得側が要求を出すだけで、実スクロールは scroll DOM を持つ描画側が行う。
両者を直接呼び合わせると data と DOM の所有が絡むため、store の signal 1 本で疎結合にしている。

## 履歴の途切れ表示

全ブランチ表示で HEAD が新しい順 maxCount ウィンドウから押し出される場合、native (`GitOps.log`) が
HEAD-only walk を末尾 append し境界に `truncatedAbove` を立てる。renderer はその境界に gap 行を挿入する。
</doc>

<script setup lang="ts">
import { BranchScope, SortMode, type GitCommit } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useElementSize, useIntervalFn, useWindowFocus } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { ResizeHandle } from "../layout";
import type { BranchChangePayload, FsWatchReadyPayload, RemoteRefsChangePayload } from "../sidebar";
import type { GitStatusChangePayload } from "../worktree";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import CommitDetailPane from "./CommitDetailPane.vue";
import { CommitContextMenu, useCommitContextMenuTrigger } from "./features/commit-context-menu";
import { CommitGraphList } from "./features/commit-list";
import GitGraphToolbar from "./GitGraphToolbar.vue";
import { buildRepoBaseUrl } from "./linkifyCommitMessage";
import { rpcGitLog } from "./rpc";
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
/** window focus 状態。背景 PR poll は focus 中のみ（blur 中の GitHub API 消費 / 失敗トースト堆積を止める）。 */
const focused = useWindowFocus();

const defaultBranch = ref<string | undefined>();
const firstParentOnly = ref(false);
// SSOT: ワイヤ型 SortMode / BranchScope をそのまま UI 状態として持ち、RPC 呼び出しで変換不要にする。
const sortMode = ref<SortMode>("date");
const branchScope = ref<BranchScope>("default");

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
      branchScope: branchScope.value,
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

// firstParentOnly / sortMode / branchScope 切替時に再取得。3 つとも callback が同一
// (resetSelection + loadLog) なので source 配列で 1 effect に束ねる。worktree.dir の watch は
// callback が別 (scroll + closure リセット) なのでここには含めない。
watch([firstParentOnly, sortMode, branchScope], () => {
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
    // よって PR 再取得は `remoteRefsChange` handler 側に集約する（store の 60s lock が重複取得を畳む）。
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

// `git fetch` / `git push` でローカルの remote-tracking ref が動いたとき発火する。PR 再取得も
// ここに集約する (current branch ref の書き換えでも本 handler が同 burst で必ず発射されるため、
// `gitStatusChange` 側と両方呼ぶ必要がない)。実取得は store の 60s lock を尊重する。
const disposeRemoteRefsChange = onMessage<RemoteRefsChangePayload>(
  "remoteRefsChange",
  ({ dir }) => {
    if (!repoStore.isSameRepoAsActive(dir)) return;
    scheduleLoadLog();
    // remote-tracking ref が動いた = push/fetch 直後で PR 状態が変わり得る。active repo を
    // 取り直す。freshness lock を尊重するため 60s 内の連続 ref 変化では撃ち直さない。
    refreshActivePrList();
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

// --- PR 情報（active repo のみ・per-repo キャッシュ + freshness lock。SSOT は `usePrListStore`） ---
//
// PR badge は active worktree の git graph にしか出ないため poll 対象は active repo のみ。
// repo 切替では prListStore が repo 単位キャッシュを即表示し（表示は `selectedRootDir` から
// 導出）、60s lock を抜けた repo だけ再取得する（claude terminals の高頻度 repo 切替で
// `gh pr list` を撃ち続けない）。focus はトリガにしない（window focus の揺れに API 取得を
// 紐付けない）が、blur 中は poll を抑制する（見ていない間に失敗トーストを積まないため）。

// active worktree が属する repo の rootDir。PR poll の対象軸。cache への write キー (これ) と
// 表示 `prByBranch` の read キーを同じ `selectedRootDir` 導出に一本化する (両者が別導出だと
// fallback 経路の差で稀に食い違いうる)。`selectedRootDir` は worktree path / rootDir 直指定 /
// fetch 前 fallback すべてを吸収する SSOT (useRepoStore.selectedRepo)。
const activeRepoRootDir = computed(() => repoStore.selectedRootDir);

// 既 push branch での `gh pr create` / `edit` / `comment` は local refs を動かさず push 経路で
// 到達不能なため、interval が PR 状態変化を反映する唯一の経路。
const PR_LIST_POLL_INTERVAL_MS = 60_000;

/** active repo の PR 一覧を lock 越しに取り直す。repo 切替のたびに呼ばれるが、store の 60s lock が
 *  実 fetch を絞るため高頻度切替でも撃ち続けない。lock 中はキャッシュのまま no-op。blur 中は撃たない
 *  （focus は抑制であってトリガではない — `useRemoteFetchSync` と同じ規律）。 */
function refreshActivePrList() {
  if (!focused.value) return;
  const rootDir = activeRepoRootDir.value;
  const dir = worktreeStore.dir;
  if (rootDir === undefined || dir === undefined) return;
  prListStore.fetchIfDue(rootDir, dir);
}

// active repo が変わったら due なら再取得（表示は `prByBranch` が `selectedRootDir` から自動追従）。
watch(activeRepoRootDir, refreshActivePrList, { immediate: true });

// 一定間隔更新。active repo を lock 越しに取り直す（60s 経過分だけ実 fetch）。
useIntervalFn(refreshActivePrList, PR_LIST_POLL_INTERVAL_MS, { immediateCallback: false });

// --- GitHub repo identity (コミットメッセージ `#N` リンク化) ---

/**
 * active worktree が属する repo の `(owner, repo)`。SSOT は repoStore.githubIdentity
 * (useSidebarData が repo 追加時に origin remote から解決して書く)。identity は repo 単位で
 * 全 worktree 共通のため、worktree dir → 所有 repo の逆引きで正しく、自前 fetch を持たない。
 */
const repoIdentity = computed(() => {
  const dir = worktreeStore.dir;
  if (dir === undefined) return undefined;
  return repoStore.findRepoOwning(dir)?.githubIdentity;
});

/** GitHub repo base URL (`https://github.com/<owner>/<repo>`)。remote 未設定 / 非 github.com は undefined。 */
const issueLinkBaseUrl = computed(() => buildRepoBaseUrl(repoIdentity.value));

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
      v-model:branch-scope="branchScope"
      v-model:sort-mode="sortMode"
      v-model:detail-open="detailOpen"
      :commit-count="commits.length"
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
