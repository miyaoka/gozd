<doc lang="md">
Recursive tree node for the changes pane. Renders folders (with collapse/expand) and file leaves with git change badges.
</doc>

<script setup lang="ts">
import type { GitFileChange } from "@gozd/proto";
import { useEventListener } from "@vueuse/core";
import { computed } from "vue";
import { getFileIconUrl, getFolderIconUrl } from "../filer";
import { useFileContextMenu } from "../navigator";
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

const { open: openContextMenu } = useFileContextMenu();

// 右クリック経路は contextmenu の中で直接 showPopover すると、同サイクルの mousedown が
// popover="auto" の light-dismiss を予約し、続く mouseup で消化されて即閉じる
// (whatwg/html#10905)。次の pointerup を 1 回 capture once で待ってから open すれば
// mousedown サイクルを抜けるため dismiss されない。
function onContextMenu(event: MouseEvent) {
  if (props.node.kind !== "file") return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const node = props.node;
  const anchor = event.currentTarget;
  const x = event.clientX;
  const y = event.clientY;
  useEventListener(
    window,
    "pointerup",
    () => {
      openContextMenu(anchor, {
        relPath: node.change.newFilePath,
        commitHash: props.commitHash,
        x,
        y,
      });
    },
    { once: true, capture: true },
  );
}
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1 px-1 py-0.5 text-left text-xs select-none hover:bg-zinc-800/60"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick"
      @contextmenu.prevent="onContextMenu"
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
      />
    </template>
  </div>
</template>
