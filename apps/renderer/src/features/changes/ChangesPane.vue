<doc lang="md">
Changed files list. Shows HEAD vs working directory by default, or a selected commit's changes from the git graph.

## Behavior

- Default (Uncommitted Changes selected): shows git status converted to GitFileChange[]
- Normal commit selected: fetches changed files via `gitCommitFiles` RPC
- Shift+click range: fetches diff between the two commits
- Clicking a file emits `select` with the relative path
</doc>

<script setup lang="ts">
import type { GitFileChange } from "@gozd/rpc";
import { UNCOMMITTED_HASH } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { getFileIconName, getIconUrl } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { useGitStatusStore, resolveGitChangeKind } from "../worktree";
import type { GitChangeKind } from "../worktree";

const emit = defineEmits<{
  select: [relPath: string];
}>();

const { request } = useRpc();
const gitGraphStore = useGitGraphStore();
const gitStatusStore = useGitStatusStore();

/** コミット選択時に取得した変更ファイル一覧 */
const commitFiles = ref<GitFileChange[]>([]);
const loading = ref(false);
/** in-flight リクエストの無効化用シーケンス番号 */
let requestSeq = 0;

/** Uncommitted Changes 行が選択されているか */
const isUncommittedMode = computed(() => gitGraphStore.selectedHash === UNCOMMITTED_HASH);

/** 範囲選択モードか */
const isRangeMode = computed(() => gitGraphStore.compareHash !== null);

/** git status の Record<string, string> を GitFileChange[] に変換 */
function gitStatusToFileChanges(statuses: Record<string, string>): GitFileChange[] {
  return Object.entries(statuses).map(([filePath, statusCode]) => {
    const kind = resolveGitChangeKind(statusCode);
    const TYPE_MAP: Record<GitChangeKind, GitFileChange["type"]> = {
      modified: "M",
      added: "A",
      deleted: "D",
      untracked: "U",
      renamed: "R",
    };
    return {
      oldFilePath: filePath,
      newFilePath: filePath,
      type: TYPE_MAP[kind],
    };
  });
}

/** 表示するファイル一覧 */
const fileChanges = computed<GitFileChange[]>(() => {
  if (isUncommittedMode.value && !isRangeMode.value) {
    return gitStatusToFileChanges(gitStatusStore.gitStatuses);
  }
  return commitFiles.value;
});

/** newFilePath でソート済み */
const sortedFiles = computed(() =>
  [...fileChanges.value].sort((a, b) => a.newFilePath.localeCompare(b.newFilePath)),
);

const fileCount = computed(() => sortedFiles.value.length);

const CHANGE_COLOR_MAP: Record<GitFileChange["type"], string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
  U: "text-green-400",
};

/** パスからファイル名部分を抽出 */
function fileName(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

/** パスからディレクトリ部分を抽出 */
function dirPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
}

// コミット選択が変わったら変更ファイルを取得
watch(
  () => [gitGraphStore.selectedHash, gitGraphStore.compareHash] as const,
  async ([hash, compareHash]) => {
    const seq = ++requestSeq;
    if (hash === UNCOMMITTED_HASH && compareHash === null) {
      commitFiles.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    const result = await tryCatch(
      request.gitCommitFiles({
        hash,
        compareHash: compareHash ?? undefined,
      }),
    );
    // 別のリクエストが発行済みなら結果を破棄
    if (seq !== requestSeq) return;
    commitFiles.value = result.ok ? result.value : [];
    loading.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-zinc-700 bg-zinc-900 text-zinc-300"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-branch] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Changes</span>
      <span v-if="fileCount > 0" class="text-xs text-zinc-500">({{ fileCount }})</span>
    </div>

    <div v-if="loading" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">Loading...</div>
    </div>

    <div v-else-if="sortedFiles.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">No changes</div>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="change in sortedFiles"
        :key="change.newFilePath"
        class="flex cursor-pointer items-center gap-1.5 px-3 py-0.5 text-xs hover:bg-zinc-800/60"
        @click="emit('select', change.newFilePath)"
      >
        <span
          class="w-4 shrink-0 text-center font-mono text-[10px] font-bold"
          :class="CHANGE_COLOR_MAP[change.type]"
        >
          {{ change.type }}
        </span>
        <img
          :src="getIconUrl(getFileIconName(fileName(change.newFilePath)))"
          class="size-4 shrink-0"
          alt=""
        />
        <span class="shrink-0" :class="CHANGE_COLOR_MAP[change.type]">
          {{ fileName(change.newFilePath) }}
        </span>
        <span v-if="dirPath(change.newFilePath)" class="truncate text-zinc-600">
          {{ dirPath(change.newFilePath) }}
        </span>
      </div>
    </div>
  </div>
</template>
