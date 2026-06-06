<doc lang="md">
Recursive tree node for the changes pane. Renders folders (with collapse/expand) and file leaves with git change badges.
</doc>

<script setup lang="ts">
import type { GitFileChange } from "@gozd/proto";
import { computed } from "vue";
import { getFileIconUrl, getFolderIconUrl } from "../filer";
import type { FileContextMenuPayload } from "../navigator";
import type { ChangesTreeNode } from "./changesTree";

const props = defineProps<{
  node: ChangesTreeNode;
  depth: number;
  /** 折りたたまれているフォルダの fullPath 集合 */
  collapsed: Set<string>;
}>();

const emit = defineEmits<{
  select: [relPath: string];
  toggleFolder: [fullPath: string];
  /**
   * 右クリック payload を NavigatorPane まで bubble する。file leaf のみ発火する
   * (folder 行は OS 標準の右クリック menu に倒すため preventDefault せず no-op)。
   * hash 解決は navigator が `useGitGraphStore.contextMenuHash` SSOT で行う。
   */
  contextMenu: [payload: FileContextMenuPayload];
}>();

const CHANGE_COLOR_MAP: Record<GitFileChange["type"], string> = {
  M: "text-warning",
  A: "text-success",
  D: "text-destructive",
  R: "text-info",
  U: "text-success",
};

const isExpanded = computed(
  () => props.node.kind === "folder" && !props.collapsed.has(props.node.anchorPath),
);

const iconUrl = computed(() => {
  const node = props.node;
  if (node.kind === "folder") {
    const leafName = node.displaySegments.at(-1);
    if (leafName === undefined) {
      throw new Error("Folder node has no display segments");
    }
    return getFolderIconUrl(leafName, isExpanded.value);
  }
  return getFileIconUrl(node.name);
});

const folderDisplayName = computed(() =>
  props.node.kind === "folder" ? props.node.displaySegments.join("/") : "",
);

function onClick(event: MouseEvent) {
  // macOS の control+click は WebKit が button=0 + click event として dispatch する
  // (webkit bugzilla 52174)。contextmenu と一緒に通常 click も発火するため、control+click
  // は context menu trigger の意図として toggle / select には倒さず contextmenu 経路に委譲。
  // gozd は macOS 専用 (root CLAUDE.md) なので ctrlKey === control+click と等価。cross-platform
  // 対応する場合は OS 判定 (navigator.platform / userAgent) で macOS 経路に絞る必要がある。
  if (event.ctrlKey) return;
  if (props.node.kind === "folder") {
    emit("toggleFolder", props.node.anchorPath);
  } else {
    emit("select", props.node.change.newFilePath);
  }
}

function onChildSelect(relPath: string) {
  emit("select", relPath);
}
function onChildToggle(fullPath: string) {
  emit("toggleFolder", fullPath);
}

/**
 * 右クリック。file leaf / folder どちらも menu 対象にする。
 *
 * - file leaf: `change.newFilePath` を relPath に
 * - folder: chain 圧縮の **最深** folder fullPath (`displayPath`) を relPath に。user が UI で
 *   見ている folder 行 (例: `.github/workflows`) は実体として一意に決まる folder path を指す
 *   ため、Copy file path として渡す path が曖昧になることはない。Filer の directory 行と
 *   同じく menu 対象に揃える
 *
 * light-dismiss 回避 (pointerup 待機) は NavigatorPane が処理する責務。本 component は
 * payload を作って emit するだけ。
 */
function onContextMenu(event: MouseEvent) {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const relPath =
    props.node.kind === "file" ? props.node.change.newFilePath : props.node.displayPath;
  event.preventDefault();
  emit("contextMenu", {
    anchorEl: event.currentTarget,
    relPath,
    x: event.clientX,
    y: event.clientY,
  });
}
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1 px-1 py-0.5 text-left text-xs select-none hover:bg-surface-1/60"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick"
      @contextmenu="onContextMenu"
    >
      <template v-if="node.kind === 'folder'">
        <span
          class="size-3.5 shrink-0 text-foreground-subtle"
          :class="isExpanded ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'"
        />
        <img :src="iconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate text-foreground">{{ folderDisplayName }}</span>
      </template>
      <template v-else>
        <span class="size-3.5 shrink-0" />
        <img :src="iconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate" :class="CHANGE_COLOR_MAP[node.change.type]">
          {{ node.name }}
        </span>
        <span
          class="ml-auto shrink-0 font-mono text-[10px] font-bold"
          :class="CHANGE_COLOR_MAP[node.change.type]"
        >
          {{ node.change.type }}
        </span>
      </template>
    </button>

    <template v-if="node.kind === 'folder' && isExpanded">
      <ChangesTreeItem
        v-for="child in node.children"
        :key="child.kind === 'folder' ? `d:${child.anchorPath}` : `f:${child.change.newFilePath}`"
        :node="child"
        :depth="depth + 1"
        :collapsed="collapsed"
        @select="onChildSelect"
        @toggle-folder="onChildToggle"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </template>
  </div>
</template>
