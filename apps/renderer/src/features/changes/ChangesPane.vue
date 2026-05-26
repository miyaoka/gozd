<doc lang="md">
Changed files tree. Shows HEAD vs working directory by default, or a selected commit's changes from the git graph.

## Display

- Files are rendered as a directory tree, GitHub PR diff style
- A folder whose only child is another folder is concatenated with the child (e.g. `.github/workflows`).
  Concatenation stops as soon as a folder contains a file or more than one entry
- Folders default to expanded; clicking a folder row toggles collapse. State is kept in `Set<string>` keyed by full path
- Each file row shows a material-icon-theme icon, the file name colored by change type, and the change type
  badge (M/A/D/R/U) at the trailing edge

## Data source

ファイル一覧の決定ロジックと RPC fetch は `useChangesStore` が SSOT。
ChangesPane は store の `fileChanges` をツリーに整形して描画するだけ。

## View all

ヘッダーの View all ボタンで `useChangesSummaryStore` を toggle する。
summary 有効時は preview ペインに全変更の縦並び diff が表示される。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import type { FileContextMenuPayload } from "../navigator";
import { buildChangesTree } from "./changesTree";
import type { ChangesTreeNode } from "./changesTree";
import ChangesTreeItem from "./ChangesTreeItem.vue";
import { useChangesStore } from "./useChangesStore";
import { useChangesSummaryStore } from "./useChangesSummaryStore";

const emit = defineEmits<{
  select: [relPath: string];
  /** 右クリック payload を NavigatorPane まで bubble する。hash 解決は navigator + store SSOT */
  contextMenu: [payload: FileContextMenuPayload];
}>();

const notify = useNotificationStore();
const changesStore = useChangesStore();
const summaryStore = useChangesSummaryStore();

/**
 * GitHub PR 風のディレクトリツリー（chain 圧縮済み）。
 *
 * `buildChangesTree` は不正 path（空 segment / 重複 / file⇔folder 衝突）で throw する。
 * computed は pure / 同期である必要があるため、ツリー構築と失敗時のトースト通知は
 * 副作用を持てる `watch` 側に閉じ込め、テンプレートには素の `ref<T[]>` を渡す。
 */
const tree = ref<ChangesTreeNode[]>([]);

watch(
  () => changesStore.fileChanges,
  (changes) => {
    const result = tryCatch(() => buildChangesTree(changes));
    if (result.ok) {
      tree.value = result.value;
      return;
    }
    tree.value = [];
    notify.error("Failed to build changes tree", result.error);
  },
  { immediate: true },
);

/** 折りたたみ中フォルダの fullPath 集合（デフォルトは全展開） */
const collapsedFolders = ref<Set<string>>(new Set());

function toggleFolder(fullPath: string) {
  const next = new Set(collapsedFolders.value);
  if (next.has(fullPath)) {
    next.delete(fullPath);
  } else {
    next.add(fullPath);
  }
  collapsedFolders.value = next;
}

function onClickViewAll() {
  summaryStore.toggle();
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-zinc-700 bg-zinc-900 text-zinc-300"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-branch] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Changes</span>
      <span v-if="changesStore.fileChanges.length > 0" class="text-xs text-zinc-500"
        >({{ changesStore.fileChanges.length }})</span
      >
      <button
        type="button"
        class="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
        :class="summaryStore.enabled ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
        :disabled="changesStore.fileChanges.length === 0"
        title="Show all diffs in preview"
        aria-label="Toggle changes summary"
        @click="onClickViewAll"
      >
        <span class="icon-[lucide--file-diff] size-3.5" />
        View all
      </button>
    </div>

    <div v-if="changesStore.loading" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">Loading...</div>
    </div>

    <div v-else-if="tree.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">No changes</div>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1">
      <ChangesTreeItem
        v-for="node in tree"
        :key="node.kind === 'folder' ? `d:${node.anchorPath}` : `f:${node.change.newFilePath}`"
        :node="node"
        :depth="0"
        :collapsed="collapsedFolders"
        @select="emit('select', $event)"
        @toggle-folder="toggleFolder"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </div>
  </div>
</template>
