<script setup lang="ts">
import { ref } from "vue";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

const props = defineProps<{
  name: string;
  /** ルートからの相対パス */
  path: string;
  isDirectory: boolean;
  isIgnored: boolean;
  depth: number;
  selectedPath?: string;
}>();

const emit = defineEmits<{
  select: [path: string];
}>();

const expanded = ref(false);
const children = ref<FileEntry[]>();
const loading = ref(false);

async function toggle() {
  if (!props.isDirectory) {
    emit("select", props.path);
    return;
  }

  expanded.value = !expanded.value;

  // 初回展開時のみ読み込む
  if (expanded.value && children.value === undefined) {
    loading.value = true;
    try {
      const entries = await window.api.fs.readDir(props.path);
      children.value = sortEntries(entries);
    } catch (e) {
      console.error(`Failed to read directory: ${props.path}`, e);
      children.value = [];
    } finally {
      loading.value = false;
    }
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

function onChildSelect(childPath: string) {
  emit("select", childPath);
}
</script>

<template>
  <div>
    <button
      class="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-zinc-700"
      :class="[
        selectedPath === path
          ? 'bg-zinc-700 text-white'
          : isIgnored
            ? 'text-zinc-500'
            : 'text-zinc-300',
      ]"
      :style="{ paddingLeft: `${depth * 16 + 4}px` }"
      @click="toggle"
    >
      <!-- ディレクトリの展開/折りたたみアイコン -->
      <span
        v-if="isDirectory"
        class="size-4 shrink-0"
        :class="expanded ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'"
      />
      <!-- ファイル用のスペーサー -->
      <span v-else class="size-4 shrink-0" />

      <span
        class="size-4 shrink-0"
        :class="
          isDirectory
            ? expanded
              ? 'icon-[lucide--folder-open]'
              : 'icon-[lucide--folder]'
            : 'icon-[lucide--file]'
        "
        :style="{ color: isIgnored ? undefined : isDirectory ? '#facc15' : '#a1a1aa' }"
      />
      <span class="truncate">{{ name }}</span>
    </button>

    <!-- 子エントリ -->
    <template v-if="isDirectory && expanded">
      <div
        v-if="loading"
        class="py-1 text-xs text-zinc-500"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 4}px` }"
      >
        Loading...
      </div>
      <FileTreeItem
        v-for="child in children"
        v-else
        :key="child.name"
        :name="child.name"
        :path="`${path}/${child.name}`"
        :is-directory="child.isDirectory"
        :is-ignored="child.isIgnored"
        :depth="depth + 1"
        :selected-path="selectedPath"
        @select="onChildSelect"
      />
    </template>
  </div>
</template>
