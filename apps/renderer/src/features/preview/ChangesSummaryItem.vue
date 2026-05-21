<doc lang="md">
Summary view の 1 ファイル分のブロック。

## データ取得

- uncommitted: `rpcGitShowFile` (HEAD) と `rpcFsReadFile` を並列で取得
- commit / range: `rpcGitShowCommitFile` で from / to を一括取得 (newer が Working Tree なら fs から to を取る)

`PreviewPane` の fetchContent / fetchCommitContent と同じ方針。差分は「単一ファイル選択を per-item に複製」した点だけ。

## 遅延フェッチ

`useIntersectionObserver` でビューポート進入を観測し、`hasBeenVisible` が true に
なってから初めて fetch を発火する。N=100 のような大きな PR でも、初描画時に同時並列
発射されるのは「画面に見える数件」だけになり、Swift 側 git プロセスの瞬間ピークを抑える。
一度 visible になったら hasBeenVisible は true で固定し、scroll-out / scroll-back では
再 fetch しない (props 変化があれば再 fetch)。

## fsChange 購読 (per-item)

`onMessage("fsChange", ...)` を各 item で個別に登録する。N=100 件 mount なら N 個の
listener が **ChangesSummaryItem コンポーネントの mount 中** ずっと存在し、1 イベントで
N 個の callback が走る (filter で大半は早期 return)。summary view を閉じる
(`summaryStore.enabled=false` で `<ChangesSummaryView v-if>` が false になる) と全 item
が unmount され、`onUnmounted(unsubscribeFsChange)` で listener も全て解除される。

これは SSOT 違反気味（同じ filter ロジックの N 重複）だが、現状 N≦100 程度では実害は
無いと判断して per-item 購読を採用する。SSOT 化の代替案は `useChangesStore` で 1 回購読
し dirty path Map を管理する形だが、IntersectionObserver による lazy fetch との噛み合
わせ調整が必要で複雑度が増す。N が想定を超えた時点で本構造を見直す。
</doc>

<script setup lang="ts">
import { type GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useIntersectionObserver } from "@vueuse/core";
import { computed, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { onMessage } from "../../shared/rpc";
import { getFileIconUrl, relDirOf, rpcFsReadFile } from "../filer";
import type { FsChangePayload } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import type { GitChangeKind } from "../worktree";
import DiffPreview from "./DiffPreview.vue";
import { rpcGitShowCommitFile, rpcGitShowFile } from "./rpc";
import { useBlamePopover } from "./useBlamePopover";

const props = defineProps<{
  change: GitFileChange;
  viewMode: "split" | "unified";
  wordWrap: boolean;
}>();

/**
 * fetch 失敗時に summary view へ通知する。view 側で 1 件の集約 toast に丸めて
 * notification.error を呼ぶ (item で都度呼ぶと N 件 fan-out で toast が大量化する)。
 * error.value は引き続き item の画面内に赤テキストで表示するので、ユーザーは
 * どのファイルが失敗したかを per-item でも確認できる。
 */
const emit = defineEmits<{
  fetchFailed: [cause: Error];
}>();

const worktreeStore = useWorktreeStore();
const gitGraphStore = useGitGraphStore();

const rootRef = useTemplateRef<HTMLElement>("rootRef");
/**
 * ビューポートに一度でも入ったか。fetch のゲート。
 * 一度 true になったら戻さない (scroll-out で fetch を取りやめると初回確認後に消える不快な
 * UX になる + 失敗 / 成功 result も捨てることになる)。
 */
const hasBeenVisible = ref(false);
useIntersectionObserver(rootRef, ([entry]) => {
  if (entry?.isIntersecting && !hasBeenVisible.value) {
    hasBeenVisible.value = true;
  }
});

const original = ref<string>();
const current = ref<string>();
const isBinary = ref(false);
const isOriginalBinary = ref(false);
const loading = ref(true);
const error = ref<string>();
const effectiveKind = ref<GitChangeKind>();

/** 表示用のファイルパス。renamed の時は newFilePath を主に使う */
const displayPath = computed(() => props.change.newFilePath || props.change.oldFilePath);

const iconUrl = computed(() => getFileIconUrl(displayPath.value.split("/").pop() ?? ""));

const TYPE_TO_KIND: Record<GitFileChange["type"], GitChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  U: "untracked",
  R: "renamed",
};

/**
 * type を kind に変換し、untracked と added は表示上同等として扱う。
 * ファイル fetch 結果から導出した `effectiveKind` を優先する (commit mode は API 越しでないと
 * 確定しないため)。fallback として GitFileChange.type を使う。
 */
const kind = computed<GitChangeKind>(() => effectiveKind.value ?? TYPE_TO_KIND[props.change.type]);

const BADGE_CLASSES: Record<GitChangeKind, string> = {
  modified: "text-yellow-400 bg-yellow-400/10",
  added: "text-green-400 bg-green-400/10",
  deleted: "text-red-400 bg-red-400/10",
  untracked: "text-green-400 bg-green-400/10",
  renamed: "text-blue-400 bg-blue-400/10",
};

const BADGE_LABEL: Record<GitChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
};

/** diff 表示可能か (modified / renamed / added(中身有) / deleted(中身有)) */
const canShowDiff = computed(() => {
  if (isBinary.value || isOriginalBinary.value) return false;
  return original.value !== undefined && current.value !== undefined;
});

/** 折りたたみ状態。デフォルト展開 */
const collapsed = ref(false);

const blamePopover = useBlamePopover();

/**
 * uncommitted / commit mode に応じた currentRev / originalRev。
 * PreviewPane と同じ規則で「Current = newer side」「Original = older 側 `<older>^`」。
 * uncommitted モードでは current="" (working tree) / original="HEAD"、
 * commit モードでは fetchCommit の newer / older を再利用する。
 */
const isCommitMode = computed(
  () => gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null,
);

type Endpoints = { newer: string; older: string | undefined };

/**
 * fetchCommit と同じ newer / older 決定ロジックを SSOT として 1 度だけ計算する。
 * commit が hashToIndex に無い (loaded log の外) ケースは null を返し、blame は disable する。
 */
const endpoints = computed<Endpoints | null>(() => {
  if (!isCommitMode.value) return null;
  const selectedHash = gitGraphStore.selectedHash;
  const compareHash = gitGraphStore.compareHash;
  if (compareHash === null) return { newer: selectedHash, older: undefined };
  if (selectedHash === UNCOMMITTED_HASH && compareHash === UNCOMMITTED_HASH) return null;
  const map = gitGraphStore.hashToIndex;
  const idxOf = (h: string) => (h === UNCOMMITTED_HASH ? -1 : map.get(h));
  const sIdx = idxOf(selectedHash);
  const cIdx = idxOf(compareHash);
  if (sIdx === undefined || cIdx === undefined) return null;
  if (sIdx >= cIdx) return { newer: compareHash, older: selectedHash };
  return { newer: selectedHash, older: compareHash };
});

const currentRev = computed<string | undefined>(() => {
  if (!isCommitMode.value) return "";
  const ep = endpoints.value;
  if (ep === null) return undefined;
  return ep.newer === UNCOMMITTED_HASH ? "" : ep.newer;
});

const originalRev = computed<string | undefined>(() => {
  if (!isCommitMode.value) return "HEAD";
  const ep = endpoints.value;
  if (ep === null) return undefined;
  if (ep.older === undefined) return `${ep.newer}^`;
  return `${ep.older}^`;
});

/**
 * DiffPreview に渡す blame button gate。renamed (R) の場合 left side / right side で
 * blame 対象 path が異なるため、両側のうち path が存在 (= 空文字でない) すれば button を出す。
 * `GitFileChange` の path は git diff 由来で worktree 相対が proto 契約のため、
 * 空文字判定だけで blameable 判定が成立する。
 */
const blameEnabled = computed(
  () => props.change.oldFilePath !== "" || props.change.newFilePath !== "",
);

function modeLabelForRev(rev: string): string {
  if (rev === "") return "Working Tree";
  if (rev === "HEAD") return "HEAD";
  return rev;
}

function onLineNumberClick(payload: {
  side: "old" | "new";
  line: number;
  anchorEl: HTMLElement;
}): void {
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  const rev = payload.side === "old" ? originalRev.value : currentRev.value;
  if (rev === undefined) return;
  // renamed (R) のとき blame 対象 path は side に揃える: old side は oldFilePath、
  // new side は newFilePath。これを取り違えると rev で存在しない path を blame して
  // 即 not_found に倒れる。fallback 反対側は path だけ揃え rev は side 側のまま使う。
  const path =
    payload.side === "old"
      ? props.change.oldFilePath || props.change.newFilePath
      : props.change.newFilePath || props.change.oldFilePath;
  // 該当 side の blame 対象 path 自体が無ければ早期 return。
  // blameEnabled が true でも片側だけ存在するケースがあるため再確認する。
  if (path === "") return;
  blamePopover.open(payload.anchorEl, {
    dir,
    relPath: path,
    rev,
    line: payload.line,
    modeLabel: modeLabelForRev(rev),
  });
}

/**
 * 自分が blame popover の owner だった場合は unmount 時に必ず close する。
 * summary view で fileChanges が更新されて item が v-for re-key で消えると、
 * popover の anchorEl は detached element を指し続けるため、明示的に close する
 * 必要がある。closeIfActive は他 owner の context を巻き込まない設計。
 * dir も渡して同名ファイル別 worktree の取り違えを防ぐ。
 */
onUnmounted(() => {
  const dir = worktreeStore.dir;
  if (dir !== undefined) {
    blamePopover.closeIfActive(dir, displayPath.value);
  }
});

let fetchVersion = 0;

async function fetchUncommitted(dir: string, version: number) {
  const newPath = props.change.newFilePath || props.change.oldFilePath;
  const oldPath = props.change.oldFilePath || props.change.newFilePath;
  const isDeleted = props.change.type === "D";

  const currentPromise = isDeleted
    ? Promise.resolve(undefined)
    : rpcFsReadFile({ dir, path: newPath });
  const originalPromise = rpcGitShowFile({ dir, relPath: oldPath });

  const fetchResult = await tryCatch(Promise.all([currentPromise, originalPromise]));
  if (version !== fetchVersion) return;

  if (!fetchResult.ok) {
    // per-item で error.value を画面内に赤テキスト表示しつつ、view 側に集約通知を投げる。
    // view 側は debounce 経由で notification.error を 1 回だけ呼ぶ (`useNotificationStore`
    // 内部で `console.error` が走るため stack も devtools に残る)。
    error.value = fetchResult.error.message;
    emit("fetchFailed", fetchResult.error);
    loading.value = false;
    return;
  }

  const [curr, orig] = fetchResult.value;
  current.value = curr?.notFound ? "" : (curr?.content ?? "");
  isBinary.value = curr?.isBinary ?? false;

  const origResult = orig.result;
  original.value = origResult?.notFound ? "" : (origResult?.content ?? "");
  isOriginalBinary.value = origResult?.isBinary ?? false;

  // untracked は HEAD に存在しないので original 側が notFound になり original="" になる。
  // 既存の type をそのまま使う。
  effectiveKind.value = undefined;
  loading.value = false;
}

async function fetchCommit(dir: string, version: number) {
  const selectedHash = gitGraphStore.selectedHash;
  const compareHash = gitGraphStore.compareHash;
  const path = props.change.newFilePath || props.change.oldFilePath;

  // 時系列で newer/older を決定 (PreviewPane.orderedRange と同じロジック)
  const map = gitGraphStore.hashToIndex;
  const idxOf = (h: string) => (h === UNCOMMITTED_HASH ? -1 : map.get(h));
  let newer: string;
  let older: string | undefined;
  if (compareHash === null) {
    newer = selectedHash;
    older = undefined;
  } else if (selectedHash === UNCOMMITTED_HASH && compareHash === UNCOMMITTED_HASH) {
    error.value = "Both endpoints are Working Tree";
    loading.value = false;
    return;
  } else {
    const sIdx = idxOf(selectedHash);
    const cIdx = idxOf(compareHash);
    if (sIdx === undefined || cIdx === undefined) {
      error.value = "Commit not found in loaded git log";
      loading.value = false;
      return;
    }
    if (sIdx >= cIdx) {
      newer = compareHash;
      older = selectedHash;
    } else {
      newer = selectedHash;
      older = compareHash;
    }
  }

  const fetchResult = await tryCatch(
    (async () => {
      if (newer === UNCOMMITTED_HASH) {
        if (older === undefined) {
          throw new Error("commit mode with working tree newer requires an older endpoint");
        }
        const [showResult, fsResult] = await Promise.all([
          rpcGitShowCommitFile({ dir, relPath: path, hash: older, compareHash: "" }),
          rpcFsReadFile({ dir, path }),
        ]);
        return {
          from: showResult.from,
          to: {
            content: fsResult.content,
            isBinary: fsResult.isBinary,
            notFound: fsResult.notFound,
          },
          unchanged: false,
        };
      }
      const showResult = await rpcGitShowCommitFile({
        dir,
        relPath: path,
        hash: newer,
        compareHash: older ?? "",
      });
      return { from: showResult.from, to: showResult.to, unchanged: showResult.unchanged };
    })(),
  );

  if (version !== fetchVersion) return;

  if (!fetchResult.ok) {
    // 上の fetchUncommitted と同じく view 側で集約。per-item で error.value を表示しつつ
    // emit で view に通知する。
    error.value = fetchResult.error.message;
    emit("fetchFailed", fetchResult.error);
    loading.value = false;
    return;
  }

  const { from, to, unchanged } = fetchResult.value;
  const fromNotFound = from?.notFound ?? true;
  const toNotFound = to?.notFound ?? true;

  if (fromNotFound && toNotFound) {
    effectiveKind.value = undefined;
  } else if (fromNotFound) {
    effectiveKind.value = "added";
  } else if (toNotFound) {
    effectiveKind.value = "deleted";
  } else if (unchanged) {
    effectiveKind.value = undefined;
  } else {
    effectiveKind.value = "modified";
  }

  original.value = fromNotFound ? "" : (from?.content ?? "");
  isOriginalBinary.value = from?.isBinary ?? false;
  current.value = toNotFound ? "" : (to?.content ?? "");
  isBinary.value = to?.isBinary ?? false;

  loading.value = false;
}

/**
 * uncommitted / commit のどちらかを発射する dispatch。state リセット込み。
 *
 * `reset=true` (デフォルト) は state を初期化してから fetch。watch trigger 経由の
 * 通常呼び出しで使う。fsChange 経由の hot reload では `reset=false` を使い、
 * 表示中の diff を loading 状態にしないまま fetch 完了で差し替える (uncommitted のみ)。
 */
async function runFetch(reset = true) {
  if (reset) {
    loading.value = true;
    error.value = undefined;
    original.value = undefined;
    current.value = undefined;
    isBinary.value = false;
    isOriginalBinary.value = false;
    effectiveKind.value = undefined;
  }

  const version = ++fetchVersion;
  const dir = worktreeStore.dir;
  if (dir === undefined) {
    loading.value = false;
    return;
  }

  const isCommitMode =
    gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null;
  if (isCommitMode) {
    await fetchCommit(dir, version);
  } else {
    await fetchUncommitted(dir, version);
  }
}

watch(
  () =>
    [
      hasBeenVisible.value,
      props.change.newFilePath,
      props.change.oldFilePath,
      gitGraphStore.selectedHash,
      gitGraphStore.compareHash,
      // commits を依存に含めることで、初回 watch で commits ロード途中 → fetchCommit が
      // `Commit not found in loaded git log` で error 確定したケースを救済する。
      // useChangesStore の watch と同じ依存集合に揃える (commits 再ロード後の stale error 防止)
      gitGraphStore.commits,
    ] as const,
  async ([visible]) => {
    // ビューポートに入るまで fetch しない (N=100 の summary で同時起動を抑制)。
    // loading = true のままにして「Loading...」を見せておく
    if (!visible) return;
    await runFetch();
  },
  { immediate: true },
);

/**
 * uncommitted モードでファイル中身が変わったら再 fetch する。
 *
 * `useChangesStore.fileChanges` は git status (状態種別) の変化しか拾わないので、
 * 例えば M → M (中身は別) のケースでは props.change の identity が変わらず watch が走らない。
 * PreviewPane の単一ファイル view と同じ fsChange 購読規律 (docs/preview.md のリアクティブ更新)
 * を summary item にも適用して、画面の diff と実ファイルの整合を保つ。
 *
 * - commit mode は無視 (表示内容は git オブジェクト由来で fs 変更とは独立)
 * - ビューポート未到達の item は `hasBeenVisible=false` のまま再 fetch をスキップ
 *   (visible になった時に通常 watch が初回 fetch するため、ここで先回りは不要)
 * - useFsWatchSync は全 worktree を watch するため active dir 以外の event は無視
 */
const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) => {
  if (!hasBeenVisible.value) return;
  if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
    return;
  }
  if (eventDir !== worktreeStore.dir) return;
  const path = props.change.newFilePath || props.change.oldFilePath;
  if (relDir !== relDirOf(path)) return;
  // fetch 前に popover を閉じる。runFetch で original / current が更新されると DiffPreview
  // が base items を再構築し button DOM が置換されるため、popover anchor が detached に
  // なる。content 入れ替えと同フレームで close することで「位置が壊れた popover が画面に
  // 残る」を構造的に防ぐ。
  blamePopover.closeIfActive(eventDir, path);
  void runFetch(false);
});
onUnmounted(unsubscribeFsChange);
</script>

<template>
  <div ref="rootRef" class="border-b border-zinc-700 last:border-b-0">
    <!-- ヘッダー: アイコン + パス + バッジ + collapse トグル -->
    <button
      type="button"
      class="flex w-full items-center gap-2 bg-zinc-800/40 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/80"
      :title="collapsed ? 'Expand' : 'Collapse'"
      :aria-label="collapsed ? 'Expand' : 'Collapse'"
      @click="collapsed = !collapsed"
    >
      <span
        class="size-3.5 shrink-0 text-zinc-500"
        :class="collapsed ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'"
      />
      <img :src="iconUrl" class="size-4 shrink-0" alt="" />
      <span class="truncate text-xs text-zinc-300">{{ displayPath }}</span>
      <span v-if="props.change.type === 'R'" class="truncate text-xs text-zinc-500">
        ← {{ props.change.oldFilePath }}
      </span>
      <span
        class="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold"
        :class="BADGE_CLASSES[kind]"
      >
        {{ BADGE_LABEL[kind] }}
      </span>
    </button>

    <!-- 中身 -->
    <div v-if="!collapsed">
      <div v-if="loading" class="px-3 py-2 text-xs text-zinc-500">Loading...</div>
      <div v-else-if="error" class="px-3 py-2 text-xs text-red-400">{{ error }}</div>
      <div v-else-if="isBinary || isOriginalBinary" class="px-3 py-2 text-xs text-zinc-500">
        Binary file — diff not available
      </div>
      <DiffPreview
        v-else-if="canShowDiff"
        :original="original ?? ''"
        :current="current ?? ''"
        :file-path="displayPath"
        :word-wrap="wordWrap"
        :external-view-mode="viewMode"
        :blame-enabled="blameEnabled"
        @line-number-click="onLineNumberClick"
      />
      <div v-else class="px-3 py-2 text-xs text-zinc-500">No diff</div>
    </div>
  </div>
</template>
