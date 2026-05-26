<doc lang="md">
Recursive tree node for the changes pane. Renders folders (with collapse/expand) and file leaves with git change badges.
</doc>

<script setup lang="ts">
import type { GitFileChange } from "@gozd/proto";
import { computed } from "vue";
import { getFileIconUrl, getFolderIconUrl } from "../filer";
import type { ChangesTreeNode } from "./changesTree";

const props = defineProps<{
  node: ChangesTreeNode;
  depth: number;
  /** 折りたたまれているフォルダの fullPath 集合 */
  collapsed: Set<string>;
  /** 右クリックメニューに渡す commit hash。working tree 由来なら undefined */
  commitHash?: string;
}>();

const emit = defineEmits<{
  select: [relPath: string];
  toggleFolder: [fullPath: string];
  /**
   * 右クリック payload を NavigatorPane まで bubble する。file leaf のみ発火する
   * (folder 行は OS 標準の右クリック menu に倒すため preventDefault せず no-op)。
   */
  contextMenu: [
    payload: {
      anchorEl: HTMLElement;
      relPath: string;
      commitHash?: string;
      x: number;
      y: number;
    },
  ];
}>();

const CHANGE_COLOR_MAP: Record<GitFileChange["type"], string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
  U: "text-green-400",
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

function onClick() {
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
 * 右クリック。folder 行は preventDefault せず OS 標準の右クリック menu に倒す
 * (folder に対する gozd メニュー action が無いため、user の OS-level menu 期待を奪わない)。
 * file leaf のみ preventDefault + emit で navigator まで bubble する。
 *
 * 同サイクル open による light-dismiss 回避 / showPopover の defer は NavigatorPane が
 * setTimeout(0) で処理する責務。本 component は payload を作って emit するだけ。
 */
function onContextMenu(event: MouseEvent) {
  if (props.node.kind !== "file") return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  emit("contextMenu", {
    anchorEl: event.currentTarget,
    relPath: props.node.change.newFilePath,
    commitHash: props.commitHash,
    x: event.clientX,
    y: event.clientY,
  });
}
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1 px-1 py-0.5 text-left text-xs select-none hover:bg-zinc-800/60"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick"
      @contextmenu="onContextMenu"
    >
      <template v-if="node.kind === 'folder'">
        <span
          class="size-3.5 shrink-0 text-zinc-500"
          :class="isExpanded ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'"
        />
        <img :src="iconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate text-zinc-300">{{ folderDisplayName }}</span>
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
        :commit-hash="commitHash"
        @select="onChildSelect"
        @toggle-folder="onChildToggle"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </template>
  </div>
</template>
