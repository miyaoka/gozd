<doc lang="md">
Summary view の 1 ファイル分のブロック。

## データ取得

- uncommitted: `rpcGitShowFile` (HEAD) と `rpcFsReadFile` を並列で取得
- commit / range: `rpcGitShowCommitFile` で from / to を一括取得 (newer が Working Tree なら fs から to を取る)

`PreviewPane` の fetchContent / fetchCommitContent と同じ方針。差分は「単一ファイル選択を per-item に複製」した点だけ。
</doc>

<script setup lang="ts">
import { type GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { getFileIconUrl, rpcFsReadFile } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import type { GitChangeKind } from "../worktree";
import DiffPreview from "./DiffPreview.vue";
import { rpcGitShowCommitFile, rpcGitShowFile } from "./rpc";

const props = defineProps<{
  change: GitFileChange;
  viewMode: "split" | "unified";
  wordWrap: boolean;
}>();

const worktreeStore = useWorktreeStore();
const gitGraphStore = useGitGraphStore();
const notification = useNotificationStore();

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
    error.value = fetchResult.error.message;
    notification.error("Failed to read file", fetchResult.error);
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
    error.value = fetchResult.error.message;
    notification.error("Failed to read commit file", fetchResult.error);
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

watch(
  () =>
    [
      props.change.newFilePath,
      props.change.oldFilePath,
      gitGraphStore.selectedHash,
      gitGraphStore.compareHash,
    ] as const,
  async () => {
    loading.value = true;
    error.value = undefined;
    original.value = undefined;
    current.value = undefined;
    isBinary.value = false;
    isOriginalBinary.value = false;
    effectiveKind.value = undefined;

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
  },
  { immediate: true },
);
</script>

<template>
  <div class="border-b border-zinc-700 last:border-b-0">
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
      />
      <div v-else class="px-3 py-2 text-xs text-zinc-500">No diff</div>
    </div>
  </div>
</template>
