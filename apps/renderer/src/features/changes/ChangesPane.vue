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

## PR diff toggle

現在ブランチに open PR があるとき、ヘッダーに PR diff toggle が表示される。ON にすると
**`merge-base(HEAD, pr.baseRefOid)`** から working tree までの diff (3-dot semantics、
untracked 含む) に切り替わる。これは GitHub の Files changed タブと同じ意味論で、PR 分岐後に
base ブランチが前進した分は差分に含めない。graph 側の選択 state には触らない (toggle ON 中も
graph 選択は維持) が、ユーザーが graph で commit を選択した瞬間に toggle は自動 OFF になる。
SSOT は `usePrDiffToggleStore`。

## View all

ヘッダーの View all ボタンは `usePreviewStore.toggleSummary` を呼び、
summary 表示モードと preview popover の開閉を同時に切り替える。
summary 有効時は preview ペインに全変更の縦並び diff が表示される。
</doc>

<script setup lang="ts">
import { ref } from "vue";
import { usePrDiffToggleStore } from "../git-graph";
import type { FileContextMenuPayload } from "../navigator";
import { usePreviewStore } from "../preview";
import ChangesTreeItem from "./ChangesTreeItem.vue";
import { useChangesStore } from "./useChangesStore";
import { useChangesSummaryStore } from "./useChangesSummaryStore";

const emit = defineEmits<{
  select: [relPath: string];
  /** 右クリック payload を NavigatorPane まで bubble する。hash 解決は navigator + store SSOT */
  contextMenu: [payload: FileContextMenuPayload];
}>();

const changesStore = useChangesStore();
const summaryStore = useChangesSummaryStore();
const previewStore = usePreviewStore();
const prDiffToggle = usePrDiffToggleStore();

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
  previewStore.toggleSummary();
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-border bg-background text-foreground"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
      <span class="icon-[lucide--git-branch] size-4 text-foreground-low" />
      <span class="text-xs font-semibold text-foreground-low">Changes</span>
      <span v-if="changesStore.fileChanges.length > 0" class="text-xs text-foreground-low"
        >({{ changesStore.fileChanges.length }})</span
      >
      <button
        v-if="prDiffToggle.canEnable"
        type="button"
        class="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs transition-colors disabled:cursor-progress disabled:opacity-60"
        :class="
          prDiffToggle.isOn ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        :title="
          prDiffToggle.enabling
            ? 'Resolving PR diff base...'
            : prDiffToggle.isOn
              ? 'Showing PR diff (base..working tree, includes untracked)'
              : 'Show PR diff (base..working tree, includes untracked)'
        "
        :disabled="prDiffToggle.enabling"
        :aria-busy="prDiffToggle.enabling"
        aria-label="Toggle PR diff"
        @click="prDiffToggle.toggle"
      >
        <span
          :class="
            prDiffToggle.enabling
              ? 'icon-[lucide--loader-circle] size-3.5 animate-spin'
              : 'icon-[lucide--git-pull-request] size-3.5'
          "
        />
        PR #{{ prDiffToggle.pr?.number }}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
        :class="[
          summaryStore.enabled ? 'text-primary-text' : 'text-foreground-low hover:text-foreground',
          prDiffToggle.canEnable ? '' : 'ml-auto',
        ]"
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
      <div class="text-xs text-foreground-low">Loading...</div>
    </div>

    <div v-else-if="changesStore.tree.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-foreground-low">No changes</div>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1">
      <ChangesTreeItem
        v-for="node in changesStore.tree"
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
