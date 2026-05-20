<doc lang="md">
変更ファイル全件の diff を縦に並べて表示するビュー。GitHub PR の Files changed タブ相当。

## 動作

- `useChangesStore` の `fileChanges` を購読し、各ファイルを `ChangesSummaryItem` で描画
- ヘッダーで split / unified の global 切替と word wrap トグルを提供
- ファイル単位の split/unified トグルは externalViewMode prop で非表示にし、ここに統合する
</doc>

<script setup lang="ts">
import { ref } from "vue";
import { useChangesStore } from "../changes";
import ChangesSummaryItem from "./ChangesSummaryItem.vue";

const emit = defineEmits<{
  close: [];
}>();

const changesStore = useChangesStore();
const viewMode = ref<"split" | "unified">("split");
const wordWrap = ref(true);
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー -->
    <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
      <span class="icon-[lucide--file-diff] size-4 shrink-0 text-zinc-400" />
      <span class="text-sm text-zinc-300">Changes summary</span>
      <span v-if="changesStore.fileChanges.length > 0" class="text-xs text-zinc-500">
        ({{ changesStore.fileChanges.length }} files)
      </span>
      <button
        type="button"
        class="ml-auto shrink-0 text-zinc-500 hover:text-zinc-300"
        title="Close preview"
        aria-label="Close preview"
        @click="emit('close')"
      >
        <span class="icon-[lucide--panel-right-close] size-4" />
      </button>
    </div>

    <!-- ツールバー: view mode と wrap を全 item に伝搬 -->
    <div class="flex items-center border-b border-zinc-700">
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="viewMode === 'split' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
        title="Split view"
        aria-label="Split view"
        @click="viewMode = 'split'"
      >
        <span class="icon-[lucide--columns-2] size-3.5" />
        Split
      </button>
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="viewMode === 'unified' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
        title="Unified view"
        aria-label="Unified view"
        @click="viewMode = 'unified'"
      >
        <span class="icon-[lucide--align-justify] size-3.5" />
        Unified
      </button>

      <button
        type="button"
        class="ml-auto flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="wordWrap ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
        @click="wordWrap = !wordWrap"
      >
        <span class="icon-[lucide--wrap-text] size-3.5" />
        Wrap
      </button>
    </div>

    <!-- 本体 -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="changesStore.loading" class="p-4 text-sm text-zinc-500">Loading changes...</div>
      <div v-else-if="changesStore.fileChanges.length === 0" class="p-4 text-sm text-zinc-500">
        No changes
      </div>
      <template v-else>
        <ChangesSummaryItem
          v-for="change in changesStore.fileChanges"
          :key="`${change.oldFilePath}->${change.newFilePath}`"
          :change="change"
          :view-mode="viewMode"
          :word-wrap="wordWrap"
        />
      </template>
    </div>
  </div>
</template>
