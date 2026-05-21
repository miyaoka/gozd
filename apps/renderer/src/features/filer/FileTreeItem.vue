<doc lang="md">
ファイルツリーの再帰的なノード。

## 動作

- ディレクトリは展開/折りたたみ可能で、初回展開時に RPC で子エントリを遅延読み込み
- material-icon-theme のアイコンを表示
- git status に応じた色分け（modified=黄、added=緑、deleted=赤、renamed=青）と削除ファイルの打ち消し線

## 更新（イベント駆動）

- filer event store の fsChange を watch して自分の path 該当時に再読み込み
- filer event store の gitStatusChange を watch して展開中なら children を再構築
- worktreeStore.revealVersion を watch して selectedPath が自分または配下なら展開＋スクロール
- 親→子の命令呼び出し（defineExpose）は使わず、各ノードが自律的にイベントを処理する設計
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import {
  resolveDirectoryGitChange,
  resolveFileGitChange,
  resolveGitChangeKind,
  useWorktreeStore,
} from "../worktree";
import type { GitChangeKind } from "../worktree";
import { getDeletedEntries, sortEntries, toFileEntries } from "./filerUtils";
import type { FileEntry } from "./filerUtils";
import { rpcFsReadDir } from "./rpc";
import { getFileIconUrl, getFolderIconUrl } from "./useFileIcon";
import { useFilerEventStore } from "./useFilerEventStore";

const GIT_CHANGE_COLOR_MAP: Record<GitChangeKind, string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  untracked: "text-green-400",
  renamed: "text-blue-400",
};

const props = defineProps<{
  name: string;
  /** ルートからの相対パス */
  path: string;
  isDirectory: boolean;
  isIgnored: boolean;
  /** ファイル自身の git 変更種別 */
  gitChange?: GitChangeKind;
  /** git status マップ全体（ディレクトリの変更種別推論に使用） */
  gitStatuses: Record<string, string>;
  depth: number;
  selectedPath?: string;
}>();

const emit = defineEmits<{
  select: [path: string];
}>();

const notify = useNotificationStore();
const worktreeStore = useWorktreeStore();
const filerEventStore = useFilerEventStore();

const buttonRef = useTemplateRef<HTMLButtonElement>("button");
const expanded = ref(false);
const children = ref<FileEntry[]>();
const loading = ref(false);

/** gitStatuses マップからリアルタイムに変更種別を算出する */
const effectiveGitChange = computed<GitChangeKind | undefined>(() => {
  // 削除エントリ（打ち消し線）は親から渡された gitChange をそのまま使う
  if (props.gitChange === "deleted") return "deleted";
  if (props.isDirectory) {
    return resolveDirectoryGitChange(props.path, props.gitStatuses);
  }
  return resolveFileGitChange(props.path, props.gitStatuses);
});

const textColorClass = computed(() => {
  if (effectiveGitChange.value) return GIT_CHANGE_COLOR_MAP[effectiveGitChange.value];
  if (props.isIgnored) return "text-zinc-500";
  if (props.selectedPath === props.path) return "text-white";
  return "text-zinc-300";
});

/** 削除ファイルかどうか */
const isDeleted = computed(() => props.gitChange === "deleted");

/** material-icon-theme のアイコン URL */
const iconUrl = computed(() => {
  if (props.isDirectory) {
    return getFolderIconUrl(props.name, expanded.value);
  }
  return getFileIconUrl(props.name);
});

async function toggle() {
  if (!props.isDirectory) {
    emit("select", props.path);
    return;
  }

  expanded.value = !expanded.value;

  // 初回展開時のみ読み込む
  if (expanded.value && children.value === undefined) {
    await loadChildren();
  }
}

async function loadChildren() {
  loading.value = true;
  const dir = worktreeStore.dir;
  if (dir === undefined) {
    children.value = [];
    loading.value = false;
    return;
  }
  const result = await tryCatch(rpcFsReadDir({ dir, path: props.path }));
  if (!result.ok) {
    // 削除ディレクトリの場合、readDir は失敗するので削除エントリのみ表示
    const deletedEntries = getDeletedEntries(props.path, props.gitStatuses);
    if (deletedEntries.length > 0) {
      children.value = sortEntries(deletedEntries);
    } else {
      notify.error(`Failed to read directory: ${props.path}`, result.error);
      children.value = [];
    }
    loading.value = false;
    return;
  }
  children.value = mergeWithGitStatus(toFileEntries(result.value.entries));
  loading.value = false;
}

/** readDir の結果に git 変更情報と削除ファイルをマージする */
function mergeWithGitStatus(entries: FileEntry[]): FileEntry[] {
  const existingNames = new Set(entries.map((e) => e.name));

  const withGitChange = entries.map((entry) => {
    const filePath = `${props.path}/${entry.name}`;
    const statusCode = props.gitStatuses[filePath];
    if (statusCode) {
      return { ...entry, gitChange: resolveGitChangeKind(statusCode) } as FileEntry;
    }
    return entry;
  });

  const deletedEntries = getDeletedEntries(props.path, props.gitStatuses).filter(
    (e) => !existingNames.has(e.name),
  );

  return sortEntries([...withGitChange, ...deletedEntries]);
}

// fsChange を購読し、自分の path が変更対象なら再読み込み（折りたたみ中はキャッシュ破棄）。
// 自分の path 配下のノードは独立に同じ store を watch しているため、再帰伝播は不要。
watch(
  () => filerEventStore.fsChangeEvent,
  (event) => {
    if (event === undefined) return;
    if (!props.isDirectory) return;
    if (event.relDir !== props.path) return;
    if (expanded.value) {
      void loadChildren();
    } else {
      // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
      children.value = undefined;
    }
  },
);

// gitStatusChange を購読し、展開中の children を再構築する（削除仮想エントリの追加/除去）。
// computed の再計算だけでは entries の追加削除を反映できないため、明示的に再読み込みする。
watch(
  () => filerEventStore.gitStatusChangeVersion,
  () => {
    if (!props.isDirectory) return;
    if (expanded.value && children.value !== undefined) {
      void loadChildren();
    } else {
      // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
      children.value = undefined;
    }
  },
);

/**
 * revealVersion 変化で worktreeStore.selectedPath を見て、自分が target または target の祖先なら処理。
 * 祖先の場合は展開するだけ。子は v-for でマウント後に自分の revealVersion watch (immediate)
 * で target を処理する再帰チェーン。
 */
async function handleReveal() {
  const targetPath = worktreeStore.selectedPath;
  if (targetPath === undefined) return;
  // 自身がターゲットの場合、展開してスクロールインビュー
  if (targetPath === props.path) {
    if (props.isDirectory && !expanded.value) {
      expanded.value = true;
      if (children.value === undefined) {
        await loadChildren();
      }
    }
    buttonRef.value?.scrollIntoView({ block: "nearest" });
    return;
  }
  // ディレクトリでないか、ターゲットが自身の配下でない場合は何もしない
  if (!props.isDirectory) return;
  if (!targetPath.startsWith(props.path + "/")) return;
  // 自身の配下に target がある場合、自分は展開するだけ（target そのものへの scroll は
  // 子の watch が処理する）。子は v-for で children を読み込むとマウントされ、
  // immediate watch が現在の revealVersion で発火する
  if (!expanded.value) {
    expanded.value = true;
    if (children.value === undefined) {
      await loadChildren();
    }
  }
}

watch(
  () => worktreeStore.revealVersion,
  () => {
    void handleReveal();
  },
  { immediate: true },
);

function onChildSelect(childPath: string) {
  emit("select", childPath);
}
</script>

<template>
  <div>
    <button
      ref="button"
      class="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-zinc-700"
      :class="[
        selectedPath === path ? 'bg-zinc-700' : '',
        textColorClass,
        isDeleted ? 'line-through opacity-60' : '',
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

      <img :src="iconUrl" class="size-4 shrink-0" :class="isIgnored ? 'opacity-50' : ''" alt="" />
      <span class="truncate">{{ name }}</span>
    </button>

    <!-- 子エントリ -->
    <template v-if="isDirectory && expanded">
      <div
        v-if="loading && !children"
        class="py-1 text-xs text-zinc-500"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 4}px` }"
      >
        Loading...
      </div>
      <FileTreeItem
        v-for="child in children"
        :key="`${child.name}-${child.isDirectory}`"
        :name="child.name"
        :path="`${path}/${child.name}`"
        :is-directory="child.isDirectory"
        :is-ignored="child.isIgnored"
        :git-change="child.gitChange"
        :git-statuses="gitStatuses"
        :depth="depth + 1"
        :selected-path="selectedPath"
        @select="onChildSelect"
      />
    </template>
  </div>
</template>
