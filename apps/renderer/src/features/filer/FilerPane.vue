<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- ワークスペースのディレクトリが設定されるとルートエントリを読み込み、FileTreeItem を再帰的にレンダリング
- fsChange / gitStatusChange の RPC メッセージを購読し、変更があったディレクトリのみ差分更新
- git 削除ファイルは仮想エントリとしてツリーに挿入
- `reveal(targetPath)` で指定パスまでツリーを展開しスクロール
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { nextTick, onUnmounted, ref, watch } from "vue";
import { useRpc } from "../rpc/useRpc";
import { dirName, getDeletedEntries, resolveGitChangeKind, sortEntries } from "./filer-utils";
import type { FileEntry } from "./filer-utils";
import FileTreeItem from "./FileTreeItem.vue";
import { useGitStatusStore } from "./useGitStatusStore";
import { useWorkspaceStore } from "./useWorkspaceStore";

const workspaceStore = useWorkspaceStore();
const { dir, selectedPath } = storeToRefs(workspaceStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);
const { request, onFsChange, onGitStatusChange } = useRpc();

const rootEntries = ref<FileEntry[]>();
const loading = ref(false);
/** rootEntries 未読み込み時に保留する reveal 対象パス */
let pendingRevealPath: string | undefined;

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
    const [entries] = await Promise.all([
      request.fsReadDir({ relPath: "." }),
      gitStatusStore.loadGitStatus(),
    ]);
    rootEntries.value = mergeWithGitStatus(entries, "");
  } catch (e) {
    console.error("Failed to read root directory", e);
    rootEntries.value = [];
  } finally {
    loading.value = false;
  }

  // rootEntries 読み込み完了後に保留中の処理を実行
  // v-for の FileTreeItem がマウントされるのを nextTick で待つ
  await nextTick();
  workspaceStore.consumeInitialFile();
  if (pendingRevealPath) {
    const path = pendingRevealPath;
    pendingRevealPath = undefined;
    void reveal(path);
  }
}

function onSelect(path: string) {
  workspaceStore.selectPath(path);
}

/**
 * 指定パスまでファイルツリーを展開し、対象ノードをスクロールインビューする。
 * ルートエントリの中から先頭セグメントに一致するアイテムを探して FileTreeItem.reveal に委譲する。
 */
async function reveal(targetPath: string): Promise<void> {
  if (!rootEntries.value) {
    // ルート読み込み中なら完了後に再試行する
    pendingRevealPath = targetPath;
    return;
  }

  const firstSegment = targetPath.split("/")[0];
  const index = rootEntries.value.findIndex((e) => e.name === firstSegment);
  if (index < 0) return;

  const item = treeItemRefs.value[index];
  if (item) {
    await item.reveal(targetPath);
  }
}

defineExpose({ reveal });

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
  gitStatusStore.setGitStatuses(statuses);
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
      workspaceStore.clearSelectedPath();
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
  <div class="flex size-full flex-col">
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
