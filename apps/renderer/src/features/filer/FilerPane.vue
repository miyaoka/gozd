<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { dirName, sortEntries } from "./filer-utils";
import FileTreeItem from "./FileTreeItem.vue";
import { useWorkspace } from "./useWorkspace";

const { dir } = useWorkspace();

const rootEntries = ref<ReturnType<typeof sortEntries>>();
const selectedPath = ref<string>();
const loading = ref(false);

async function loadRoot() {
  loading.value = true;
  try {
    const entries = await window.api.fs.readDir(".");
    rootEntries.value = sortEntries(entries);
  } catch (e) {
    console.error("Failed to read root directory", e);
    rootEntries.value = [];
  } finally {
    loading.value = false;
  }
}

function onSelect(path: string) {
  selectedPath.value = path;
}

/**
 * ファイル変更通知を受けてツリーを更新するコールバック。
 * FileTreeItem の reloadDir を呼ぶため、ref 経由で子コンポーネントにアクセスする。
 */
const treeItemRefs = ref<InstanceType<typeof FileTreeItem>[]>([]);

function handleFsChange(relDir: string) {
  // ルートディレクトリの変更（"" or "."）
  if (relDir === "" || relDir === ".") {
    void loadRoot();
    return;
  }
  // 子ディレクトリの変更 → 該当する FileTreeItem に通知
  for (const item of treeItemRefs.value) {
    item.notifyChange(relDir);
  }
}

watch(
  dir,
  (newDir) => {
    if (newDir) {
      rootEntries.value = undefined;
      selectedPath.value = undefined;
      void loadRoot();
    }
  },
  { immediate: true },
);

const unsubscribeFsChange = window.api.fs.onChange(handleFsChange);
onUnmounted(() => {
  unsubscribeFsChange();
});
</script>

<template>
  <div class="flex w-64 shrink-0 flex-col border-r border-zinc-700">
    <!-- ヘッダー -->
    <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
      <span class="icon-[lucide--folder-tree] text-blue-400" />
      <span class="text-sm font-bold text-zinc-300">{{ dir ? dirName(dir) : "Files" }}</span>
    </div>

    <!-- ツリー本体 -->
    <div class="flex-1 overflow-y-auto p-1">
      <div v-if="!dir" class="px-2 py-4 text-center text-sm text-zinc-500">
        waiting for open command...
      </div>
      <div v-else-if="loading && !rootEntries" class="px-2 py-4 text-center text-sm text-zinc-500">
        Loading...
      </div>
      <template v-else>
        <FileTreeItem
          v-for="entry in rootEntries"
          ref="treeItemRefs"
          :key="entry.name"
          :name="entry.name"
          :path="entry.name"
          :is-directory="entry.isDirectory"
          :is-ignored="entry.isIgnored"
          :depth="0"
          :selected-path="selectedPath"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>
