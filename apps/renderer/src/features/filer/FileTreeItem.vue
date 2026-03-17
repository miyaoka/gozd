<doc lang="md">
ファイルツリーの再帰的なノード。

## 動作

- ディレクトリは展開/折りたたみ可能で、初回展開時に RPC で子エントリを遅延読み込み
- material-icon-theme のアイコンを表示
- git status に応じた色分け（modified=黄、added=緑、deleted=赤、renamed=青）と削除ファイルの打ち消し線

## 更新

- 親から `notifyChange` / `notifyGitStatusChange` を呼ばれてツリーを差分更新
- `reveal(targetPath)` でパスのセグメントを再帰的に辿って展開し、対象ノードをスクロールインビュー
</doc>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from "vue";
import { useRpc } from "../rpc/useRpc";
import {
  getDeletedEntries,
  resolveDirectoryGitChange,
  resolveFileGitChange,
  resolveGitChangeKind,
  sortEntries,
} from "./filer-utils";
import type { FileEntry, GitChangeKind } from "./filer-utils";
import { getFileIconName, getFolderIconName, getIconUrl } from "./useFileIcon";

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

const { request } = useRpc();

const buttonRef = useTemplateRef<HTMLButtonElement>("button");
const expanded = ref(false);
const children = ref<FileEntry[]>();
const childRefs = ref<InstanceType<typeof import("./FileTreeItem.vue").default>[]>([]);
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
    return getIconUrl(getFolderIconName(props.name, expanded.value));
  }
  return getIconUrl(getFileIconName(props.name));
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
  try {
    const entries = await request.fsReadDir({ relPath: props.path });
    children.value = mergeWithGitStatus(entries);
  } catch (e) {
    // 削除ディレクトリの場合、readDir は失敗するので削除エントリのみ表示
    const deletedEntries = getDeletedEntries(props.path, props.gitStatuses);
    if (deletedEntries.length > 0) {
      children.value = sortEntries(deletedEntries);
    } else {
      console.error(`Failed to read directory: ${props.path}`, e);
      children.value = [];
    }
  } finally {
    loading.value = false;
  }
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

/**
 * ファイル変更通知を受けて、該当するディレクトリの内容を再読み込みする。
 * 自身のパスに一致すれば再読み込み、さもなくば子に伝播する。
 */
function notifyChange(relDir: string) {
  if (!props.isDirectory) return;

  // 自身のディレクトリが変更対象
  if (relDir === props.path) {
    if (expanded.value) {
      void loadChildren();
    } else {
      // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
      children.value = undefined;
    }
    return;
  }

  // 自身の配下のパスなら子に伝播
  if (relDir.startsWith(props.path + "/")) {
    for (const child of childRefs.value) {
      child.notifyChange(relDir);
    }
  }
}

/**
 * git status 変更通知を受けて、展開中のディレクトリの children を再構築する。
 * 削除仮想エントリの追加/除去は children の再構築が必要なため、
 * computed の再計算だけでは対応できない。
 */
function notifyGitStatusChange() {
  if (!props.isDirectory) return;

  if (expanded.value && children.value !== undefined) {
    void loadChildren();
  } else {
    // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
    children.value = undefined;
  }

  for (const child of childRefs.value) {
    child.notifyGitStatusChange();
  }
}

/**
 * 指定パスまでツリーを展開し、対象ノードをビューポートにスクロールする。
 * パスのセグメントを再帰的に辿り、各ディレクトリを非同期で展開する。
 */
async function reveal(targetPath: string): Promise<void> {
  // 自身がターゲットの場合、スクロールインビュー
  if (targetPath === props.path) {
    buttonRef.value?.scrollIntoView({ block: "nearest" });
    return;
  }

  // ディレクトリでないか、ターゲットが自身の配下でない場合は何もしない
  if (!props.isDirectory) return;
  if (!targetPath.startsWith(props.path + "/")) return;

  // 展開する（未展開かつ子が未読み込みの場合は読み込む）
  if (!expanded.value) {
    expanded.value = true;
    if (children.value === undefined) {
      await loadChildren();
    }
  }

  // childRefs は v-for の template ref なので、DOM 更新を待つ
  await nextTick();

  // 次のパスセグメントに一致する子を探して再帰
  const nextSegment = targetPath.slice(props.path.length + 1).split("/")[0];
  const childIndex = children.value?.findIndex((c) => c.name === nextSegment);
  if (childIndex !== undefined && childIndex >= 0) {
    const child = childRefs.value[childIndex];
    if (child) {
      await child.reveal(targetPath);
    }
  }
}

defineExpose({ notifyChange, notifyGitStatusChange, reveal });

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

      <img
        v-if="iconUrl"
        :src="iconUrl"
        class="size-4 shrink-0"
        :class="isIgnored ? 'opacity-50' : ''"
        alt=""
      />
      <span
        v-else
        class="size-4 shrink-0"
        :class="
          isDirectory
            ? expanded
              ? 'icon-[lucide--folder-open]'
              : 'icon-[lucide--folder]'
            : isDeleted
              ? 'icon-[lucide--file-x]'
              : 'icon-[lucide--file]'
        "
        :style="{ color: isIgnored ? undefined : isDirectory ? '#facc15' : '#a1a1aa' }"
      />
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
        ref="childRefs"
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
