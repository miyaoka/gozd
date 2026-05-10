<doc lang="md">
共有 ⋮ ポップオーバーメニュー。

worktree / branch の各セクションから呼ばれ、
コンテキストに応じたアクション（編集・削除・作成）を表示する。
`showPopover({ source })` の implicit anchor で ⋮ ボタンの直下に配置する。

親から `openMenu()` を expose 経由で呼び出してメニューを開く。
アクション選択時は emit で親に通知し、メニューを閉じる。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/proto";
import { nextTick, ref } from "vue";

defineProps<{
  isCreating: boolean;
}>();

const emit = defineEmits<{
  worktreeEditTask: [wt: WorktreeEntry, rootDir: string];
  worktreeRemove: [wt: WorktreeEntry, rootDir: string];
  branchLink: [branch: string, rootDir: string];
}>();

type MenuContext =
  | { type: "worktree"; worktree: WorktreeEntry; rootDir: string }
  | { type: "branch"; branch: string; rootDir: string };

/**
 * showPopover に渡す `source` 引数の型。
 * Popover API の最新仕様（HTMLElement.showPopover(options)）。
 * lib.dom.d.ts への取り込みが追いついていないため最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

const menuRef = ref<PopoverElement>();
const menuContext = ref<MenuContext>();

function openMenu(anchorEl: HTMLElement, context: MenuContext) {
  menuContext.value = context;
  nextTick(() => {
    menuRef.value?.showPopover({ source: anchorEl });
  });
}

function closeMenu() {
  menuRef.value?.hidePopover();
}

function handleWorktreeEditTask(wt: WorktreeEntry, rootDir: string) {
  closeMenu();
  emit("worktreeEditTask", wt, rootDir);
}

function handleWorktreeRemove(wt: WorktreeEntry, rootDir: string) {
  closeMenu();
  emit("worktreeRemove", wt, rootDir);
}

function handleBranchLink(branch: string, rootDir: string) {
  closeMenu();
  emit("branchLink", branch, rootDir);
}

defineExpose({ openMenu });
</script>

<template>
  <div
    ref="menuRef"
    popover="auto"
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
  >
    <template v-if="menuContext?.type === 'worktree' && menuContext.worktree">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
        @click="handleWorktreeEditTask(menuContext.worktree, menuContext.rootDir)"
      >
        <span class="icon-[lucide--pencil] text-xs" />
        Edit task
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleWorktreeRemove(menuContext.worktree, menuContext.rootDir)"
      >
        <span class="icon-[lucide--unlink] text-xs" />
        Remove worktree
      </button>
    </template>
    <template v-else-if="menuContext?.type === 'branch' && menuContext.branch">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
        :disabled="isCreating"
        @click="handleBranchLink(menuContext.branch, menuContext.rootDir)"
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
