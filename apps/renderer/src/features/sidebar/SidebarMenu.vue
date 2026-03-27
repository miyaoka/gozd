<doc lang="md">
共有 ⋮ ポップオーバーメニュー。

worktree / branch の各セクションから呼ばれ、
コンテキストに応じたアクション（編集・削除・作成）を表示する。
CSS Anchor Positioning で ⋮ ボタンの直下に配置。

親から `openMenu()` を expose 経由で呼び出してメニューを開く。
アクション選択時は emit で親に通知し、メニューを閉じる。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { nextTick, ref } from "vue";

defineProps<{
  isCreating: boolean;
}>();

const emit = defineEmits<{
  worktreeEditTask: [wt: WorktreeEntry];
  worktreeRemove: [wt: WorktreeEntry];
  branchLink: [branch: string];
}>();

interface MenuContext {
  type: "worktree" | "branch";
  worktree?: WorktreeEntry;
  branch?: string;
}

const menuRef = ref<HTMLElement>();
const menuContext = ref<MenuContext>();
/** 現在 anchor になっている ⋮ ボタンの anchor-name */
const activeAnchorName = ref("");

function openMenu(anchorName: string, context: MenuContext) {
  activeAnchorName.value = anchorName;
  menuContext.value = context;
  nextTick(() => {
    menuRef.value?.showPopover();
  });
}

function closeMenu() {
  menuRef.value?.hidePopover();
}

function handleWorktreeEditTask(wt: WorktreeEntry) {
  closeMenu();
  emit("worktreeEditTask", wt);
}

function handleWorktreeRemove(wt: WorktreeEntry) {
  closeMenu();
  emit("worktreeRemove", wt);
}

function handleBranchLink(branch: string) {
  closeMenu();
  emit("branchLink", branch);
}

defineExpose({ openMenu });
</script>

<template>
  <div
    ref="menuRef"
    popover="auto"
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      positionAnchor: activeAnchorName,
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
  >
    <template v-if="menuContext?.type === 'worktree' && menuContext.worktree">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
        @click="handleWorktreeEditTask(menuContext.worktree)"
      >
        <span class="icon-[lucide--pencil] text-xs" />
        Edit task
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleWorktreeRemove(menuContext.worktree)"
      >
        <span class="icon-[lucide--unlink] text-xs" />
        Remove worktree
      </button>
    </template>
    <template v-else-if="menuContext?.type === 'branch' && menuContext.branch">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
        :disabled="isCreating"
        @click="handleBranchLink(menuContext.branch)"
      >
        <span class="icon-[lucide--link] text-xs" />
        Create worktree
      </button>
    </template>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
