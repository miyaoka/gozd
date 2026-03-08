<script setup lang="ts">
import { ref, watch } from "vue";
import FileTreeItem from "./FileTreeItem.vue";
import { useWorkspace } from "./useWorkspace";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

const { dir } = useWorkspace();

const rootEntries = ref<FileEntry[]>();
const selectedPath = ref<string>();
const loading = ref(false);

/** ディレクトリパスの末尾から表示名を抽出 */
function dirName(dirPath: string): string {
  const parts = dirPath.split("/");
  return parts[parts.length - 1] ?? dirPath;
}

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

/** ディレクトリ優先 → 名前順 */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function onSelect(path: string) {
  selectedPath.value = path;
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
