<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { useRpc } from "../rpc/useRpc";
import { dirName, getDeletedEntries, resolveGitChangeKind, sortEntries } from "./filer-utils";
import type { FileEntry } from "./filer-utils";
import FileTreeItem from "./FileTreeItem.vue";
import { useGitStatus } from "./useGitStatus";
import { useSelectedPath } from "./useSelectedPath";
import { useWorkspace } from "./useWorkspace";

const { dir } = useWorkspace();
const { gitStatuses, loadGitStatus, setGitStatuses } = useGitStatus();
const { request, onFsChange, onGitStatusChange } = useRpc();
const { selectedPath, select, clear: clearSelection } = useSelectedPath();

const rootEntries = ref<FileEntry[]>();
const loading = ref(false);

/** readDir の結果に git 変更情報と削除ファイルをマージする */
function mergeWithGitStatus(entries: FileEntry[], dirPath: string): FileEntry[] {
  const existingNames = new Set(entries.map((e) => e.name));

  // 既存エントリに git 変更種別を付与
  const withGitChange = entries.map((entry) => {
    const filePath = dirPath === "" ? entry.name : `${dirPath}/${entry.name}`;
    const statusCode = gitStatuses.value[filePath];
    if (statusCode) {
      return { ...entry, gitChange: resolveGitChangeKind(statusCode) } as FileEntry;
    }
    return entry;
  });

  // 削除ファイルを追加（既存エントリと重複しないもののみ）
  const deletedEntries = getDeletedEntries(dirPath, gitStatuses.value).filter(
    (e) => !existingNames.has(e.name),
  );

  return sortEntries([...withGitChange, ...deletedEntries]);
}

async function loadRoot() {
  loading.value = true;
  try {
    const [entries] = await Promise.all([request.fsReadDir({ relPath: "." }), loadGitStatus()]);
    rootEntries.value = mergeWithGitStatus(entries, "");
  } catch (e) {
    console.error("Failed to read root directory", e);
    rootEntries.value = [];
  } finally {
    loading.value = false;
  }
}

function onSelect(path: string) {
  select(path);
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

async function handleGitStatusChange(statuses: Record<string, string>) {
  setGitStatuses(statuses);
  // 削除ファイルのエントリ追加/除去のためルートを再構築
  // loadGitStatus は不要（プッシュ通知で受け取った値を使う）
  try {
    const entries = await request.fsReadDir({ relPath: "." });
    rootEntries.value = mergeWithGitStatus(entries, "");
  } catch (e) {
    console.error("Failed to rebuild root entries", e);
  }
  // 展開中の子ディレクトリにも通知して children を再構築させる
  for (const item of treeItemRefs.value) {
    item.notifyGitStatusChange();
  }
}

watch(
  dir,
  (newDir) => {
    if (newDir) {
      rootEntries.value = undefined;
      clearSelection();
      void loadRoot();
    }
  },
  { immediate: true },
);

const unsubscribeFsChange = onFsChange(({ relDir }) => handleFsChange(relDir));
const unsubscribeGitStatus = onGitStatusChange(({ statuses }) => handleGitStatusChange(statuses));
onUnmounted(() => {
  unsubscribeFsChange();
  unsubscribeGitStatus();
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
          :git-change="entry.gitChange"
          :git-statuses="gitStatuses"
          :depth="0"
          :selected-path="selectedPath"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>
