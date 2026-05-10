<doc lang="md">
Recursive tree node for the changes pane. Renders folders (with collapse/expand) and file leaves with git change badges.
</doc>

<script setup lang="ts">
import type { GitFileChange } from "@gozd/proto";
import { computed } from "vue";
import { getFileIconName, getFolderIconName, getIconUrl } from "../filer";
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
    return getIconUrl(getFolderIconName(node.leafName, isExpanded.value));
  }
  return getIconUrl(getFileIconName(node.name));
});

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
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1 px-1 py-0.5 text-left text-xs hover:bg-zinc-800/60"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick"
    >
      <template v-if="node.kind === 'folder'">
        <span
          class="size-3.5 shrink-0 text-zinc-500"
          :class="isExpanded ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'"
        />
        <img :src="iconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate text-zinc-300">{{ node.displayName }}</span>
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
      />
    </template>
  </div>
</template>
