<script setup lang="ts">
import { ref } from "vue";
import type { FileContextMenuPayload } from "../filer";
import ChangesTreeItem from "./ChangesTreeItem.vue";
import PrDiffSegmented from "./PrDiffSegmented.vue";
import { useChangesStore } from "./useChangesStore";
import { useChangesSummaryStore } from "./useChangesSummaryStore";
import IconLucideFileDiff from "~icons/lucide/file-diff";

const emit = defineEmits<{
  select: [relPath: string];
  /** 右クリック payload を NavigatorPane まで bubble する。hash 解決は navigator + store SSOT */
  contextMenu: [payload: FileContextMenuPayload];
  /** View all ボタン。summary + preview popover の同時切り替えは親が preview store に繋ぐ */
  viewAll: [];
}>();

const changesStore = useChangesStore();
const summaryStore = useChangesSummaryStore();

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
  emit("viewAll");
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-border bg-background text-foreground"
  >
    <div
      class="@container flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs whitespace-nowrap"
    >
      <span class="shrink-0 font-semibold text-foreground-low">Changes</span>
      <span
        v-if="changesStore.orderedFileChanges.length > 0"
        class="hidden text-foreground-low @min-[220px]:inline"
        >({{ changesStore.orderedFileChanges.length }})</span
      >
      <div class="flex flex-1 items-center justify-end gap-1">
        <PrDiffSegmented />
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 px-1.5 py-0.5 transition-colors"
          :class="
            summaryStore.enabled ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
          "
          :disabled="changesStore.orderedFileChanges.length === 0"
          title="Show all diffs in preview"
          aria-label="Toggle changes summary"
          @click="onClickViewAll"
        >
          <IconLucideFileDiff class="size-3.5 shrink-0" />
          <span class="hidden @min-[330px]:inline">View all</span>
        </button>
      </div>
    </div>

    <div v-if="changesStore.loading" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-foreground-low">Loading...</div>
    </div>

    <div
      v-else-if="changesStore.orderedFileChanges.length === 0"
      class="flex-1 overflow-y-auto p-2"
    >
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
